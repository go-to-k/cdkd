#!/usr/bin/env bash
# Smoke test for branch-gate.sh.
#
# Exercises the cwd-aware branch resolution against fixture git
# worktrees, asserting both the BLOCK (exit 2) and ALLOW (exit 0)
# outcomes. Run from the repo root: `bash .claude/hooks/branch-gate.test.sh`.
#
# Why a shell script and not a vitest test: the hook IS a shell
# script, the contract IS the stdin JSON payload + exit code. A
# TypeScript wrapper would test the wrapper, not the hook.

set -u

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/branch-gate.sh"

# --- MACHINE INDEPENDENCE ----------------------------------------------------
# The developer's own git config must not decide what this suite exercises, and
# before this block it did. Measured by breaking the hook's `rebase-merge`
# detection arm and running the suite:
#
#   default on the author's machine                  38 pass /  4 fail   catches it
#   with a global `rebase.backend = apply`           42 pass /  0 fail   GREEN, broken hook
#
# `rebase.backend = apply` sends every plain `git rebase` down `rebase-apply/`
# instead, so the `rebase-merge` arm is never reached and the rows that exist to
# hold it down pass without exercising it. Two more ordinary global options turn
# half the suite red against the UNMUTATED hook, for the same inheritance:
#
#   global `commit.gpgsign = true`                   25 pass / 21 fail
#   global `init.templateDir = <dir with a hook>`    25 pass / 21 fail
#
# The author's machine HAS `init.templateDir` set (git-secrets), so this suite
# was green only because those installed hooks happen to exit 0. That is exactly
# the "green for a reason other than the one claimed" class the rest of this
# file exists to correct, landing in the file itself.
#
# `/dev/null` rather than an empty scratch file: nothing to clean up, and a
# stray `git config --global` from a child cannot write to it. Honoured since
# git 2.32; an older git ignores both variables and is no worse off than before.
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_SYSTEM=/dev/null
# Two consequences, both already satisfied below and stated so they stay so:
# `init.defaultBranch` is gone, so every `git init` here passes an explicit
# `-b`; and there is no global identity, so every commit brings its own.

# Per-run scratch dir; cleaned on EXIT.
#
# NOT named `TMPDIR`, which is what it used to be. That variable is already
# exported in the environment this suite inherits, and assigning to an exported
# name keeps the export -- so every child process, git included, was writing its
# own temporaries inside the fixture that the EXIT trap then deleted. A private
# name leaves the ambient `TMPDIR` alone, which is also what `mktemp` reads.
# (On this macOS box `mktemp -d` with no template ignores `TMPDIR` entirely and
# uses the Darwin per-user temp dir, so the old assignment could not even move
# the fixture; on Linux `mktemp` does honour it. Renaming is correct on both
# without having to know which one is running.)
FIXROOT="$(mktemp -d)"
trap 'rm -rf "$FIXROOT"' EXIT

# --- BASH INTERPRETER FENCE (go-to-k/cdkd#2402) ------------------------------
# Running this SUITE under bash 3.2 did NOT run the HOOK under it. The hook is
# `#!/usr/bin/env bash`, which resolves through PATH and finds whatever bash is
# first there -- the 5.x on a dev Mac -- so every "under 3.2" tally this file
# ever printed was taken against a 5.x subject, and `run-tests.sh` exported
# HOOK_BASH to a file that ignored it.
#
# So the interpreter is an explicit symlink at the FRONT of PATH, the shape the
# sibling repo's `gate-command-recognition.test.sh` already uses. Default
# `/bin/bash`; `HOOK_BASH=/opt/homebrew/bin/bash bash .claude/hooks/branch-gate.test.sh`
# takes the 5.x tally, and `run-tests.sh` already exports HOOK_BASH per shell. An
# explicitly set HOOK_BASH that is not executable is FATAL rather than a silent
# fall-back: a typo'd override that quietly ran the default would report the
# version it did not run.
#
# PROVEN TO REACH THE HOOK, not merely to be exported. With `;;&` (a bash-4
# `case` terminator, a PARSE error under 3.2 and valid syntax under 5.x)
# injected into the hook's detached-HEAD arm, this suite reports
# 43 pass / 30 fail under `HOOK_BASH=/bin/bash` and 73 pass / 0 fail under
# `HOOK_BASH=/opt/homebrew/bin/bash` -- same suite, same mutant, only the
# interpreter differs. A shim that did not reach the subject would print the
# same tally twice.
#
# THE PAIR THAT USED TO STAND HERE WAS STALE, and stale in the direction that
# flatters: it predated the resulting-HEAD rows, so it under-reported both the
# damage under 3.2 and the clean 5.x total. `.claude/rules/hooks-branch-gate.md`
# already carried the corrected pair (41/25 and 66/0), so the code and the doc
# disagreed inside one file tree, and the doc was the one telling the truth.
# Numbers that are cheap to leave behind are exactly the ones to re-measure
# whenever rows are added; this round did, and both sides now say 43/30 and 73/0.
#
# WHAT THIS MUTANT IS BLIND TO, and why -- because 43 of the rows still
# pass under it and a reader should not mistake that for coverage:
#
#   Every row that wants exit 2 passes, because a bash PARSE ERROR *is*
#     exit 2 -- for the wrong reason.
#   Every row that wants exit 0 and EXITS BEFORE the broken construct is
#     parsed also passes. Bash parses a script one complete command at a time, and the
#     mutation sits inside the single `if [ -z "$branch" ]; then ... fi`
#     compound; a payload that leaves at the verb match, at the repo opt-in, or
#     at "not a git repo" never reaches it. Those rows are genuinely unaffected.
#
# So the mutant proves the INTERPRETER reached the hook, which is its job here.
# It is not a fence on the arm's logic, and the tally is not a coverage figure.
#
# PATH keeps its existing entries after the shim rather than being replaced with
# `/usr/bin:/bin`: the hook needs `jq`, which is not in either on every machine.
if [ -n "${HOOK_BASH:-}" ]; then
  # RESOLVE A BARE NAME BEFORE TESTING IT. `run-tests.sh` loops over the
  # CANDIDATES `bash` and `/bin/bash` and exports `HOOK_BASH="$shell"`, so the
  # PATH shell arrives here as the bare word `bash` -- and `-x` does no PATH
  # lookup, so testing the raw value FATALs on a perfectly good interpreter.
  # Measured: the first shape of this block failed the whole suite with
  # `FATAL - HOOK_BASH is not an executable: bash` on the 5.x pass of
  # `bash .claude/hooks/run-tests.sh`, while the 3.2 pass (an absolute
  # `/bin/bash`) passed -- so half the matrix went missing and the tally said
  # FAIL rather than saying nothing, which is the only reason it was caught.
  # The `ln -sf` below needs an absolute target anyway.
  case "$HOOK_BASH" in
    */*) ;;
    *) HOOK_BASH="$(command -v "$HOOK_BASH" 2>/dev/null || printf '%s' "$HOOK_BASH")" ;;
  esac
  if [ ! -x "$HOOK_BASH" ]; then
    printf 'FATAL - HOOK_BASH is not an executable: %s\n' "$HOOK_BASH" >&2
    exit 1
  fi
else
  HOOK_BASH=/bin/bash
  [ -x "$HOOK_BASH" ] || HOOK_BASH="$(command -v bash)"
  [ -n "$HOOK_BASH" ] && [ -x "$HOOK_BASH" ] || {
    printf 'FATAL - no usable bash found for the hook\n' >&2
    exit 1
  }
fi
SHIM="$FIXROOT/bin"; mkdir -p "$SHIM"
ln -sf "$HOOK_BASH" "$SHIM/bash"
printf 'hook interpreter: %s (bash %s)\n' "$HOOK_BASH" \
  "$("$HOOK_BASH" -c 'echo "$BASH_VERSION"')"

# Two fixture git working trees: one on `main`, one on a feature branch.
# Both have a config user so commit works if we ever exercise it.
main_repo="$FIXROOT/main-repo"
feature_repo="$FIXROOT/feature-repo"
git init -q -b main "$main_repo"
git -C "$main_repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
git init -q -b feature/x "$feature_repo"
git -C "$feature_repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
# Opt the fixtures into the gate (issue #1259): the gate only protects
# repos with a .markgate.yml at the repo root.
touch "$main_repo/.markgate.yml" "$feature_repo/.markgate.yml"

# The other protected branch NAME. `main|master` is one case arm with two
# patterns and only one of them had a row, so half of it was free to delete.
master_repo="$FIXROOT/master-repo"
git init -q -b master "$master_repo"
git -C "$master_repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
touch "$master_repo/.markgate.yml"
# A repo WITHOUT .markgate.yml (e.g. a personal blog repo worked on
# from a cdkd session) must never be gated, even on main.
optout_repo="$FIXROOT/optout-repo"
git init -q -b main "$optout_repo"
git -C "$optout_repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init

# --- DETACHED-HEAD fixture (go-to-k/cdkd#2402) -------------------------------
# A MAIN checkout that owns a real LINKED worktree. `main_repo` above cannot
# discriminate the two halves of the detached verdict, because it has no linked
# worktree for the allowed half to live in.
mt_repo="$FIXROOT/mt-repo"
mt_wt="$FIXROOT/mt-wt"
git init -q -b main "$mt_repo"
touch "$mt_repo/.markgate.yml"
mkdir -p "$mt_repo/sub"
touch "$mt_repo/sub/f.txt"
git -C "$mt_repo" -c user.email=t@t -c user.name=t add -A
git -C "$mt_repo" -c user.email=t@t -c user.name=t commit -q -m init
mt_sha=$(git -C "$mt_repo" rev-parse HEAD)
git -C "$mt_repo" -c user.email=t@t -c user.name=t worktree add -q "$mt_wt" -b lane/y
# The same fixture at a path containing a SPACE. `git worktree list --porcelain`
# emits one `worktree <path>` line, and reading it with awk's `$2` truncates at
# the space -- the compare then never matches and the gate stands down over a
# main checkout it mis-read. `substr($0, 10)` reads the whole field; this case
# is what says so.
mt_spaced="$FIXROOT/mt repo spaces"
mt_spaced_wt="$FIXROOT/mt wt spaces"
git init -q -b main "$mt_spaced"
touch "$mt_spaced/.markgate.yml"
# `add -A` + a real commit, NOT `commit --allow-empty`, which is what this was.
# `.markgate.yml` is the gate's opt-in signal and an UNTRACKED one does not
# appear in a linked worktree -- so the spaced-worktree row below asked the hook
# a question it exited before reaching, and was green for that reason rather
# than for the one its name gives.
git -C "$mt_spaced" -c user.email=t@t -c user.name=t add -A
git -C "$mt_spaced" -c user.email=t@t -c user.name=t commit -q -m init
mt_spaced_sha=$(git -C "$mt_spaced" rev-parse HEAD)
git -C "$mt_spaced" -c user.email=t@t -c user.name=t worktree add -q "$mt_spaced_wt" -b lane/s

pass=0
fail=0
fail_log=""

# run_case <name> <expect_exit> <stdin_json>
run_case() {
  local name="$1"; local want="$2"; local payload="$3"
  local got out
  out=$(printf '%s' "$payload" | env PATH="$SHIM:$PATH" "$HOOK" 2>&1) || true
  got=$?
  # The above always evaluates to 0 (`|| true`), so capture status
  # via a separate run.
  printf '%s' "$payload" | env PATH="$SHIM:$PATH" "$HOOK" >/dev/null 2>&1
  got=$?
  if [[ "$got" == "$want" ]]; then
    pass=$((pass + 1))
    printf 'OK   %s (exit %s)\n' "$name" "$got"
  else
    fail=$((fail + 1))
    fail_log+="FAIL $name: want exit $want, got $got\n"
    fail_log+="  payload: $payload\n"
    fail_log+="  output : $out\n"
    printf 'FAIL %s (want %s, got %s)\n' "$name" "$want" "$got"
  fi
}

# run_case_msg <name> <expect_exit> <stdin_json> <substring that MUST appear> \
#              [<substring that must NOT appear>] [<a second one>]
#
# BOTH REMEDY ARMS EXIT 2, so an rc-only case cannot tell the operation-specific
# wording from the plain one -- and the whole point of the operation-specific arm
# is that the plain one names a command git refuses. The verdict under test here
# is the TEXT, so the text is what is asserted.
#
# The forbidden needle for an operation row is `Re-attach first`, the literal
# opening of the fallback remedy LINE, and not the string `switch main`: the
# operation arms mention `switch main` themselves, in the sentence explaining why
# it is unavailable. A needle that also matches prose about the wrong answer
# cannot say whether the wrong answer was PRINTED.
#
# `grep -F --` because several needles start with a `-`.
run_case_msg() {
  local name="$1"; local want="$2"; local payload="$3"; local need="$4"
  local forbid="${5:-}"; local forbid2="${6:-}"
  local out got ok=1 why="" __f
  out=$(printf '%s' "$payload" | env PATH="$SHIM:$PATH" "$HOOK" 2>&1)
  printf '%s' "$payload" | env PATH="$SHIM:$PATH" "$HOOK" >/dev/null 2>&1
  got=$?
  if [ "$got" != "$want" ]; then ok=0; why="want exit $want, got $got"; fi
  if [ -n "$need" ] && ! printf '%s\n' "$out" | grep -qF -- "$need"; then
    ok=0; why="${why:+$why; }message lacks: $need"
  fi
  for __f in "$forbid" "$forbid2"; do
    if [ -n "$__f" ] && printf '%s\n' "$out" | grep -qF -- "$__f"; then
      ok=0; why="${why:+$why; }message must not contain: $__f"
    fi
  done
  if [ "$ok" = 1 ]; then
    pass=$((pass + 1))
    printf 'OK   %s (exit %s)\n' "$name" "$got"
  else
    fail=$((fail + 1))
    fail_log+="FAIL $name: $why\n"
    fail_log+="  payload: $payload\n"
    fail_log+="  output : $out\n"
    printf 'FAIL %s (%s)\n' "$name" "$why"
  fi
}

# run_case_hook <hook path> <name> <expect_exit> <stdin_json> <needle>
#
# run_case_msg against a COPY of the hook instead of the lane's own file. It
# exists for the fail-CLOSED arms, whose subject is the hook's shared matcher
# library being absent or truncated -- a state that cannot be produced without
# either editing the checkout or driving a copy, and only one of those is
# acceptable in a test.
run_case_hook() {
  local hook="$1"; local name="$2"; local want="$3"; local payload="$4"; local need="$5"
  local out got ok=1 why=""
  out=$(printf '%s' "$payload" | env PATH="$SHIM:$PATH" "$hook" 2>&1)
  printf '%s' "$payload" | env PATH="$SHIM:$PATH" "$hook" >/dev/null 2>&1
  got=$?
  if [ "$got" != "$want" ]; then ok=0; why="want exit $want, got $got"; fi
  if [ -n "$need" ] && ! printf '%s\n' "$out" | grep -qF -- "$need"; then
    ok=0; why="${why:+$why; }message lacks: $need"
  fi
  if [ "$ok" = 1 ]; then
    pass=$((pass + 1))
    printf 'OK   %s (exit %s)\n' "$name" "$got"
  else
    fail=$((fail + 1))
    fail_log="${fail_log}FAIL $name: $why\n  payload: $payload\n  output : $out\n"
    printf 'FAIL %s (%s)\n' "$name" "$why"
  fi
}

# run_case_head <name> <repo> <stdin_json> <remedy substring> <expected HEAD> \
#               <claim substring> [<substring that must NOT appear>]
#
# ASSERTS THE RESULTING HEAD, the observable the previous round did not take. That
# round verified every printed remedy EXITS 0 -- all nine do -- and the message
# then promised `--abort` would "re-attach", which is true for exactly one of the
# six operations. An exit status cannot see that; HEAD can.
#
# So this helper closes the loop rather than reading the message twice. It drives
# the hook, requires the sentence the message CLAIMS about HEAD, then EXTRACTS the
# printed remedy line verbatim (trailing `# comment` stripped), EVALS it, and
# compares the tree's actual HEAD against <expected HEAD>. Two independent things
# must agree with the measurement -- what git does, and what the message said git
# would do -- so a wrong remedy and a wrong promise each turn a row red alone.
#
# Running the line verbatim also proves it is COPY-PASTEABLE: the fixture path is
# a `/private/var` symlink target and the quoting is the hook's own.
#
# <expected HEAD> is the literal `branch <name>` or the literal `DETACHED`.
run_case_head() {
  local name="$1"; local repo="$2"; local payload="$3"; local need="$4"
  local want_head="$5"; local claim="$6"; local forbid="${7:-}"
  local out got line rc got_head remedy_out ok=1 why=""
  out=$(printf '%s' "$payload" | env PATH="$SHIM:$PATH" "$HOOK" 2>&1)
  printf '%s' "$payload" | env PATH="$SHIM:$PATH" "$HOOK" >/dev/null 2>&1
  got=$?
  if [ "$got" != 2 ]; then ok=0; why="want exit 2, got $got"; fi
  if ! printf '%s\n' "$out" | grep -qF -- "$need"; then
    ok=0; why="${why:+$why; }message lacks the remedy: $need"
  fi
  if ! printf '%s\n' "$out" | grep -qF -- "$claim"; then
    ok=0; why="${why:+$why; }message lacks the HEAD claim: $claim"
  fi
  if [ -n "$forbid" ] && printf '%s\n' "$out" | grep -qF -- "$forbid"; then
    ok=0; why="${why:+$why; }message must not contain: $forbid"
  fi
  line=$(printf '%s\n' "$out" | grep -F -- "$need" | head -1)
  # Strip the trailing ` # after resolving the conflict` the hook prints on its
  # `--continue` / `--abort` lines. `%` (SHORTEST suffix) anchored on the space
  # before the `#`, not `%%#*`, which was the first spelling: that one cut at
  # the FIRST `#` anywhere in the line, so a checkout path containing one left
  # `git -C "<truncated` -- an unterminated quote, rc=2, charged to the hook.
  # Reproduced by building the fixture under a path with a `#` in it. Suite-only;
  # the hook prints the path whole. The shortest-suffix form still cuts at the
  # real comment when the path holds a `#` too, because the comment is last.
  line="${line% #*}"
  if [ -z "$line" ]; then
    ok=0; why="${why:+$why; }no remedy line to run"
  else
    remedy_out=$(eval "$line" 2>&1)
    rc=$?
    # Capture the remedy's own words. An exit code alone cannot be diagnosed from
    # a CI log on a machine you do not have -- and this row has already cost one
    # wrong diagnosis for exactly that reason.
    if [ "$rc" != 0 ]; then
      ok=0
      why="${why:+$why; }the printed remedy exited $rc: ${remedy_out}"
    fi
  fi
  got_head=$(git -C "$repo" symbolic-ref --short HEAD 2>/dev/null || echo "")
  if [ -n "$got_head" ]; then got_head="branch $got_head"; else got_head="DETACHED"; fi
  if [ "$got_head" != "$want_head" ]; then
    ok=0; why="${why:+$why; }HEAD after the remedy is '$got_head', want '$want_head'"
  fi
  if [ "$ok" = 1 ]; then
    pass=$((pass + 1))
    printf 'OK   %s (HEAD after remedy: %s)\n' "$name" "$got_head"
  else
    fail=$((fail + 1))
    fail_log+="FAIL $name: $why\n"
    fail_log+="  payload: $payload\n"
    fail_log+="  output : $out\n"
    printf 'FAIL %s (%s)\n' "$name" "$why"
  fi
}

# --- ALLOW cases ---

# 1. Non-git command always passes through.
run_case "non-git command always allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"ls -la"}}' "$main_repo")"

# 2. git command other than commit/push (e.g. status) is allowed even on main.
run_case "git status on main allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git status"}}' "$main_repo")"

# 3. git commit on a feature branch — the happy path.
run_case "git commit on feature branch allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m wip"}}' "$feature_repo")"

# 4. git -C <feature> commit, even when cwd is on main → ALLOW
#    (the actual git operation targets the feature working tree).
run_case "git -C <feature> commit from main-cwd allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git -C %s commit -m wip"}}' "$main_repo" "$feature_repo")"

# 5. cd <feature> && git commit, even when payload cwd is main.
run_case "cd <feature> && git commit from main-cwd allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"cd %s && git commit -m wip"}}' "$main_repo" "$feature_repo")"

# 6. A dir that is not inside a git repo at all: nothing to read, so nothing to
#    gate. This case's name USED TO SAY "Detached HEAD / non-git dir", which
#    collapsed two conditions that share one observable (an empty
#    `symbolic-ref`) and are not the same thing -- a detached HEAD is a real
#    repo whose tree has LEFT `main`. That conflation is go-to-k/cdkd#2402; the
#    detached rows now live in their own block below, and this row keeps only
#    the reading it actually exercises.
run_case "non-git target dir allowed (genuinely nothing to see)" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m wip"}}' "$FIXROOT")"

# --- ALLOW cases for read-only `git` commands that contain the literal
# words `commit` / `push` in args or refspecs (issue #281).
#
# Pre-fix the regex `\bgit[^|;&]*\b(commit|push)\b` matched any git
# invocation that mentioned `commit` / `push` anywhere on the line —
# blocking legitimate read-only ops like `git rev-parse <sha>^{commit}`
# even on `main`. The tightened regex requires `commit` / `push` to
# appear in the GIT SUBCOMMAND POSITION.

# 7a. `git rev-parse <sha>^{commit}` — `^{commit}` is git's peel-to-commit
#     syntax, NOT the commit subcommand. Must pass-through even on main.
run_case "git rev-parse <sha>^{commit} on main allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git rev-parse abc123^{commit}"}}' "$main_repo")"

# 7b. `git cat-file -e <sha>^{commit}` — same peel-to-commit; this is the
#     exact repro from the issue body.
run_case "git cat-file -e <sha>^{commit} on main allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git cat-file -e abc^{commit}"}}' "$main_repo")"

# 7c. `git log --grep=commit` — `commit` is a literal in a search query,
#     not the subcommand.
run_case "git log --grep=commit on main allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git log --grep=commit"}}' "$main_repo")"

# 7d. `git log --grep=push` — same shape for the `push` keyword.
run_case "git log --grep=push on main allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git log --grep=push"}}' "$main_repo")"

# 7e. `git diff <range> -- '*push*.md'` — `push` is part of a pathspec.
run_case "git diff with push pathspec on main allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git diff abc def -- '\''*push*.md'\''"}}' "$main_repo")"

# 7f. `git diff <range> -- '*commit*.md'` — same shape for `commit`.
run_case "git diff with commit pathspec on main allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git diff abc def -- '\''*commit*.md'\''"}}' "$main_repo")"

# 7g. `git rev-list HEAD..main --oneline | head -5` — read-only revlist
#     that pipes into another command; no commit/push subcommand.
run_case "git rev-list piped on main allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git rev-list HEAD..main --oneline | head -5"}}' "$main_repo")"

# 7h. `git symbolic-ref HEAD` — pure read; trivially shouldn't trigger.
run_case "git symbolic-ref HEAD on main allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git symbolic-ref HEAD"}}' "$main_repo")"

# --- BLOCK cases ---

# 7. Plain git commit when cwd is on main.
run_case "git commit on main blocked" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m oops"}}' "$main_repo")"
# `master`, the other half of the gate's `main|master` arm and the half no row
# reached: dropping `master` from that case left the whole suite green.
run_case "git commit on master blocked" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m oops"}}' "$master_repo")"

# 8. git push on main blocked too.
run_case "git push on main blocked" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git push origin main"}}' "$main_repo")"
# The branch-NAME arm's MESSAGE, which no row read: gutting the body while
# keeping `exit 2` left the suite green, so the oldest verdict in this file was
# pinned only by its exit code. Two rows, because the two halves fail
# separately -- the diagnosis (which branch, in which tree) and the remedy.
run_case_msg "branch-NAME block names the offending branch" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m oops"}}' "$main_repo")" \
  "is on branch 'main'"
run_case_msg "branch-NAME block prints the feature-branch remedy" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m oops"}}' "$main_repo")" \
  "switch -c fix/xxx"

# 9. cd <main> && git commit from a feature-branch cwd. The cd target
#    is what matters, not the inherited cwd. THIS is the regression
#    case the rewrite fixes.
run_case "cd <main> && git commit from feature-cwd blocked" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"cd %s && git commit -m oops"}}' "$feature_repo" "$main_repo")"

# 10. git -C <main> commit. Same logic via -C.
run_case "git -C <main> commit blocked" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git -C %s commit -m oops"}}' "$feature_repo" "$main_repo")"

# 11. Single-line `git -C <a> status; git -C <b> commit` — chained
#     shape where the second `git` is NOT at line-start. With the
#     line-start anchored matcher (per memory rule
#     feedback_hook_command_match_line_start.md, issue #563), the
#     Formerly an ACCEPTED FALSE-NEGATIVE: the line-start matcher saw
#     only the first `git -C <feature> status` token, which is not a
#     commit/push subcommand, so the hook short-circuited (exit 0) and
#     a commit to main chained after a `;` went through.
#
#     Issue #1455 closed that. The matcher now recognises the verb in
#     COMMAND POSITION (line start OR after `&&` / `||` / `;` / `|`),
#     so the second `git -C <main> commit` is seen and blocked. The
#     quoted-body false-positives this anchoring originally existed to
#     prevent are handled directly now, by stripping quoted spans
#     before matching — see the Part C cases below, which still pass.
run_case "single-line chained git -C status; git -C commit is now CAUGHT (#1455)" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git -C %s status; git -C %s commit -m oops"}}' "$feature_repo" "$feature_repo" "$main_repo")"

# 11b. `git -c <key>=<val> commit` — global `-c` flag before commit
#      subcommand. The tightened regex must not get confused by the
#      `<key>=<val>` token (which can contain the literal substring
#      `commit`, e.g. `commit.gpgSign=false`).
run_case "git -c commit.gpgSign=false commit on main blocked" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git -c commit.gpgSign=false commit -m oops"}}' "$main_repo")"

# The SPACED variant of the line above, and the reason go-to-k/cdkd#2200 exists.
# `commit.gpgSign=false` has no space, so it never exercised the hole: the value
# alternative stopped at the first space, which meant a value CONTAINING one
# ended the flag loop mid-value and the verb was never reached. Measured on the
# parent commit, this gate returned rc=0 -- a commit straight to `main`, with
# every gate keyed on GATE_FLAGS equally blind. It was pinned only at the
# pattern level until this case; the pattern is where the fix lives, but the
# gate is where the damage was.
run_case "git -c with a SPACED value, commit on main blocked" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git -c user.name=\\"Jane Doe\\" commit -m oops"}}' "$main_repo")"
run_case "git --author with a spaced value, commit on main blocked" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git --author=\\"Jane Doe\\" commit -m oops"}}' "$main_repo")"
# Polarity control at the GATE level: the same spelling on a non-commit verb
# must still pass, or the widening has simply made this gate fire on everything.
run_case "git -c with a spaced value, non-commit verb passes" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git -c user.name=\\"Jane Doe\\" status"}}' "$main_repo")"

# 11c. `git push --force` on main — `--force` after the subcommand.
run_case "git push --force on main blocked" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git push origin --force"}}' "$main_repo")"

# --- REPO OPT-IN SCOPE cases (issue #1259) ---
#
# The gate must fire ONLY in repos that carry a .markgate.yml at the
# repo root. A cdkd session regularly touches unrelated personal repos
# (blog drafts, scratch clones) whose normal workflow is committing
# straight to main; those must pass through untouched.

# 11d. git commit on main in a NON-opted-in repo → allow.
run_case "git commit on main in non-opted-in repo allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m ok"}}' "$optout_repo")"

# 11e. git push on main in a NON-opted-in repo → allow.
run_case "git push on main in non-opted-in repo allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git push origin main"}}' "$optout_repo")"

# --- Edge cases ---

# 12. Missing .cwd in payload → fall back to hook process $PWD.
#    Not exercised end-to-end (we'd need to control $PWD); just
#    confirm the hook does not crash on missing cwd.
run_case "missing .cwd does not crash" 0 \
  '{"tool_input":{"command":"git status"}}'

# 13. Empty stdin payload → cmd empty → allowed (nothing to gate).
run_case "empty stdin allowed" 0 \
  ''

# --- THE FAIL-CLOSED ARMS ----------------------------------------------------
#
# The hook's header spends a paragraph on this discipline and cites
# go-to-k/cdkd#2130 for it: the first shape here was `[ -r … ] || exit 0`, which
# silently disabled the gate whenever the shared matcher was unreadable, so a
# refusal replaced it. What no row held down was the refusal ITSELF -- flipping
# either arm to `exit 0` left this suite fully green. A fail-closed arm that
# nothing pins is a fail-OPEN arm waiting to be re-introduced by the next
# person who reads `exit 2` as noise.
#
# Driven against COPIES, so the lane's own hook is never touched. The payload is
# an ordinary gated command in an opted-in repo, and the refusal lands before
# any repo is looked at -- which is itself the property being asserted.
fc_mk() {
  mkdir -p "$1/lib"
  cp "$HOOK" "$1/branch-gate.sh"
}
fc_ok="$FIXROOT/fc-ok"; mkdir -p "$fc_ok"; fc_mk "$fc_ok"
cp "${HOOK%/*}/lib/command-match.sh" "$fc_ok/lib/command-match.sh"
fc_missing="$FIXROOT/fc-missing"; mkdir -p "$fc_missing"; fc_mk "$fc_missing"
fc_trunc="$FIXROOT/fc-trunc"; mkdir -p "$fc_trunc"; fc_mk "$fc_trunc"
# "Loads, but defines nothing" -- the partial-source shape the `declare -F`
# check exists for, which a plain readability test cannot see.
printf '# truncated\n' > "$fc_trunc/lib/command-match.sh"

fc_payload=$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m oops"}}' "$main_repo")

# A CONTROL FOR THE TWO ROWS BELOW, and only for those: the same copy WITH its
# library still blocks, which is what says their refusals come from the missing
# library rather than from the hook having been copied somewhere. Neither
# fail-closed mutation reddens it. It is NOT an inert row in general, and saying
# so would be the mislabel this file has twice avoided by measuring: it reads the
# branch-NAME message, so gutting that message reddens it alongside the
# branch-NAME row above (measured: 2 red, not 1).
run_case_hook "$fc_ok/branch-gate.sh" "copied hook WITH its matcher library still blocks on main" \
  2 "$fc_payload" "is on branch 'main'"
run_case_hook "$fc_missing/branch-gate.sh" "matcher library MISSING: gate refuses (fail CLOSED)" \
  2 "$fc_payload" "Blocked: .claude/hooks/lib/command-match.sh"
run_case_hook "$fc_trunc/branch-gate.sh" "matcher library TRUNCATED: gate refuses (fail CLOSED)" \
  2 "$fc_payload" "Blocked: .claude/hooks/lib/command-match.sh"

# --- LINE-START ANCHORING cases (issue #563) ---
#
# The matcher MUST NOT fire when the literal substrings `git commit` /
# `git push` appear inside a quoted argument body of an unrelated
# command. Per memory rule feedback_hook_command_match_line_start.md,
# applied to branch-gate.sh in issue #563 (mirroring the PR #562 fix
# to check-gate.sh).

# 14. `gh issue create --body "...git commit..."` on main: the body
#     mentions `git commit` but the command itself starts with `gh`.
#     MUST pass through (would otherwise block routine issue creation).
run_case "gh issue body quoting 'git commit' on main allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh issue create --body \"we should add a git commit hook later\""}}' "$main_repo")"

# 15. `echo "...git push..."` on main: the body mentions `git push`
#     but the command starts with `echo`. MUST pass through.
run_case "echo body quoting 'git push' on main allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"echo \"reminder: git push origin main later\""}}' "$main_repo")"

# --- Unexpanded target (go-to-k/cdkd#2027) -----------------------------------
# `git -C "$W" ...` is the spelling this repo's own instructions hand people for
# worktree commits, and the hand-rolled `-C` scan this gate used to carry
# resolved it to the literal `<cwd>/$W`: the repo probe failed and the gate
# exited 0 while sitting on `main`. Measured against the pre-fix hook, both
# cases below returned 0.
run_case "unexpanded git -C on main REFUSED" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git -C \\"$W\\" commit -m oops"}}' "$main_repo")"

run_case "unexpanded git -C push on main REFUSED" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git -C \\"$W\\" push origin HEAD"}}' "$main_repo")"

# The bound moved, DELIBERATELY (go-to-k/cdkd#2027 review, minor 5). It used to
# ask the PAYLOAD CWD "is this a markgate repo?" -- i.e. it consulted the cwd
# precisely when the target was unknown, so a session whose cwd had drifted out
# of the worktree got a silent pass on the very command the refusal exists for.
# The question is now answered from the HOOK's own checkout, so an unreadable
# target is refused wherever the cwd happens to be. The friction is bounded: it
# takes a command that names its target with a variable to trigger it.
run_case "unexpanded git -C refuses even from a non-markgate cwd" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git -C \\"$W\\" commit -m x"}}' "$optout_repo")"

# The ORDINARY opt-in is untouched: a READABLE target in a repo with no
# `.markgate.yml` still passes through, which is what keeps this gate off the
# unrelated checkouts a session touches.
run_case "readable target in a non-markgate repo still passes through" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m x"}}' "$optout_repo")"

# --- DETACHED HEAD (go-to-k/cdkd#2402) ---------------------------------------
#
# `symbolic-ref --short HEAD` is EMPTY on a detached HEAD, so the gate's
# `case "$branch" in main|master)` matched neither arm and fell to `exit 0`.
# Measured on a scratch opted-in repo before the fix, same payload both times:
# rc=2 on `main`, rc=0 once detached -- while `main-tree-branch-gate.sh` passes
# `git checkout <sha>` in the main checkout, so the route to that state is one
# allowed command.
#
# BOTH POLARITIES ARE PINNED, because the fix has an allowed half that is easy
# to lose: a detached HEAD in a LINKED worktree is what this repo's own
# `stop-unmerged-lane-warn.sh` tells a session to do (`git switch --detach
# origin/main`) when it must not remove its worktree.

git -C "$mt_repo" checkout -q --detach "$mt_sha"

run_case "detached HEAD in the MAIN checkout: commit BLOCKED" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m oops"}}' "$mt_repo")"
run_case "detached HEAD in the MAIN checkout: push BLOCKED" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git push origin HEAD"}}' "$mt_repo")"
# The cwd one level DOWN. The gate compares TOPLEVELS rather than the raw
# resolved dir, so a subdirectory of the main checkout is still the main
# checkout. `main_tree_of` in main-tree-branch-gate.sh compares the raw dir and
# would answer "not the main checkout" here.
run_case "detached HEAD in the MAIN checkout, cwd a SUBDIR: BLOCKED" 2 \
  "$(printf '{"cwd":"%s/sub","tool_input":{"command":"git commit -m oops"}}' "$mt_repo")"
# Reached by `-C` from a LINKED worktree cwd, so the verdict is on the RESOLVED
# tree and not on where the session happens to be sitting.
run_case "detached MAIN checkout via -C from a worktree: BLOCKED" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git -C %s commit -m oops"}}' "$mt_wt" "$mt_repo")"
# The payload cwd reached through an EXPLICIT SYMLINK to the main checkout, which
# is the fence for reason (ii) in the hook's toplevel-compare comment: the cwd
# carries whatever symlink the caller typed, the porcelain path does not.
#
# WHY IT NEEDS ITS OWN ROW even though the four rows above already die under the
# `$target_dir` mutation. They die for reason (ii) only because macOS's
# `mktemp -d` hands back a `/var` path git reports as `/private/var`, so the whole
# fixture is symlinked for free. Rebuild the same fixture on a NON-symlinked root
# and that mutation kills exactly one of the five -- the subdir row, for reason
# (i). This repo pins the suite to `macos-latest` in `.github/workflows/hooks.yml`
# (the only runner image carrying bash 3.2), so the accident holds here; the two
# sibling repos run the same suite from `ci.yml` on `ubuntu-latest`, where `/tmp`
# is a real directory and it does not. This row dies on both roots.
ln -sfn "$mt_repo" "$FIXROOT/mt-link"
run_case "detached MAIN checkout via a SYMLINKED cwd: BLOCKED" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m oops"}}' "$FIXROOT/mt-link")"
# Polarity control at the VERB level: the new arm must not turn this gate into
# "refuse everything in a detached main checkout".
run_case "detached HEAD in the MAIN checkout: git status still allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git status"}}' "$mt_repo")"

# The LINKED worktree, while the MAIN checkout is still detached -- so a gate
# that blocked on "some tree in this repo is detached" would fail here.
run_case "LINKED worktree on a branch, main checkout detached: allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m wip"}}' "$mt_wt")"

git -C "$mt_repo" checkout -q main

# The main checkout on a FEATURE branch, with a linked worktree present: the
# control that says the block above is about DETACHMENT and not about being the
# main checkout of a repo that has worktrees.
git -C "$mt_repo" checkout -q -b feat/z
run_case "MAIN checkout on a feature branch: allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m wip"}}' "$mt_repo")"
git -C "$mt_repo" checkout -q main
# ...and back on `main` it blocks again, by NAME, exactly as before.
run_case "MAIN checkout re-attached to main: commit BLOCKED" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m oops"}}' "$mt_repo")"

# The ALLOWED half: a detached HEAD in a LINKED worktree.
git -C "$mt_wt" switch -q --detach "$mt_sha"
run_case "detached HEAD in a LINKED worktree: STILL ALLOWED" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m wip"}}' "$mt_wt")"
run_case "detached HEAD in a LINKED worktree, cwd a SUBDIR: STILL ALLOWED" 0 \
  "$(printf '{"cwd":"%s/sub","tool_input":{"command":"git commit -m wip"}}' "$mt_wt")"
run_case "detached LINKED worktree via -C from the main checkout: ALLOWED" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git -C %s commit -m wip"}}' "$mt_repo" "$mt_wt")"
git -C "$mt_wt" switch -q lane/y

# A detached MAIN checkout whose PATH CONTAINS A SPACE. Both polarities, so a
# reader can see the space is the only variable.
git -C "$mt_spaced" checkout -q --detach "$mt_spaced_sha"
run_case "detached HEAD in a SPACED main checkout: BLOCKED" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m oops"}}' "$mt_spaced")"
# ...and its polarity twin, which until this round was neither DETACHED (the
# worktree was on `lane/s`) nor opted in (see the fixture note above), and so
# survived the one mutation it existed to catch: blocking EVERY detached tree
# reddens the three unspaced linked rows and left this one green. Both halves
# are fixed here -- the fixture tracks `.markgate.yml`, and the worktree is
# actually detached -- so the row now reaches the main-vs-linked compare.
git -C "$mt_spaced_wt" switch -q --detach "$mt_spaced_sha"
run_case "detached HEAD in a SPACED linked worktree: ALLOWED" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m wip"}}' "$mt_spaced_wt")"
git -C "$mt_spaced_wt" switch -q lane/s
git -C "$mt_spaced" checkout -q main

# The OPT-IN still governs the new arm: a detached HEAD in a repo with no
# `.markgate.yml` is none of this gate's business.
git -C "$optout_repo" checkout -q --detach HEAD
run_case "detached HEAD in a NON-opted-in repo: allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m ok"}}' "$optout_repo")"
git -C "$optout_repo" checkout -q main


# --- THE REMEDY MUST BE A COMMAND GIT ACCEPTS (go-to-k/cdkd#2402 review) ------
#
# The arm above blocks correctly and, before this round, printed
# `git -C <main> switch main` unconditionally. A conflicted rebase is one of the
# ways a MAIN checkout reaches a detached HEAD -- and `git pull` on `main` in the
# main checkout is this repo's own mandated post-merge sync, so the route is a
# documented one. Measured on git 2.53, mid-rebase in the main checkout:
#
#   git commit -m resolve   ->  rc=2 (correct)
#   the remedy it printed   ->  git -C <main> switch main
#   what git answers        ->  fatal: cannot switch branch while rebasing
#
# A gate that refuses correctly and then names an impossible command is worse
# than one that does not refuse, because the reader has nowhere to go. The block
# stays; the remedy now follows the operation.
#
# EVERY REMEDY BELOW WAS RUN, not just read: each `--abort` / `bisect reset` the
# gate printed was executed verbatim against the fixture and exited 0 (rebase,
# rebase -i, rebase --apply, am, cherry-pick, merge, revert, bisect).
#
# WHAT EACH ROW HOLDS DOWN, measured by mutating the hook and re-running this
# suite. TWO numbers per mutation, `<in this block> / <whole suite>`, because
# the resulting-HEAD block below shares these rows' subject and dies with them
# (cdkd numbers; the siblings differ only in the pre-existing case count):
#
#   never detect an operation                -> 7 / 16 (the six op rows + bisect)
#   report every operation as a `rebase`     -> 5 / 11 (am, cherry-pick, merge, revert, bisect)
#   drop the `applying` sentinel             -> 1 / 2  (am, and only am)
#   `<target_dir>/.git` for the git dir      -> 1 / 1  (the mid-rebase SUBDIR row)
#   always print the operation wording       -> 1 / 1  (the NOTHING-in-progress row)
#
# Re-measured this round, after the bisect polarity row was added below. The
# IN-BLOCK numbers did not move; the two whole-suite ones each gained 1, both
# from that new row. Recording the re-measurement rather than only the result,
# because the pair one section down had gone stale unnoticed for exactly the
# reason a table like this does: adding rows changes it, and nothing checks it.
#
# The one row below with no mutation against it is labelled a CONTROL where it
# stands, rather than left looking like a fence.
op_repo="$FIXROOT/op-repo"
op_wt="$FIXROOT/op-wt"
opg() { git -C "$op_repo" -c user.email=t@t -c user.name=t "$@"; }
git init -q -b main "$op_repo"
# Identity in the REPO's own config, not only in the `opg` wrapper's `-c` flags.
# The resulting-HEAD rows run the remedy the hook PRINTS, verbatim, and that line
# carries no `-c` -- so a machine with no global identity answers `Committer
# identity unknown` (exit 128) and the row blames the remedy for the fixture.
# Measured: green locally, red on the CI runner, which has no global identity.
# Setting it here is also the more faithful fixture: a user copy-pasting that
# line has an identity, and the row is about whether the line WORKS.
git -C "$op_repo" config user.email hook-test@example.invalid
git -C "$op_repo" config user.name "Hook Test"
touch "$op_repo/.markgate.yml"
mkdir -p "$op_repo/sub"
touch "$op_repo/sub/f.txt"
printf 'base\n' > "$op_repo/f.txt"
opg add -A
opg commit -q -m base
opg checkout -q -b other
printf 'other\n' > "$op_repo/f.txt"
opg commit -q -am other
opg checkout -q main
# Six more commits so `git bisect` lands on something that is NOT a branch tip:
# with a two-commit history it picks an endpoint and HEAD stays ATTACHED, and the
# bisect row would then be exercising the branch-NAME arm instead of this one.
for op_i in 1 2 3 4 5 6; do
  printf 'mine%s\n' "$op_i" > "$op_repo/f.txt"
  opg commit -q -am "m$op_i"
done
op_root=$(git -C "$op_repo" rev-list --max-parents=0 HEAD)
opg worktree add -q "$op_wt" -b lane/op
opg format-patch -q -1 other -o "$FIXROOT/op-patches" >/dev/null
# Assert that a row's fixture actually entered the operation it is about. Called
# right after EVERY operation setup in both blocks below and before the hook
# runs, so a fixture that silently did not start reports ITSELF rather than
# blaming the hook's remedy.
op_assert_inflight() {
  local want="$1" label="$2" found=""
  # FIRST-match-wins, spelled as an if/elif chain in the hook's own precedence
  # order. It used to be a run of `[ … ] && found=…` lines, which is LAST-match
  # -wins: the two disagree for any state where more than one marker is present
  # at once, and then the fixture assertion and the hook under test would be
  # answering different questions. Latent today -- git does not currently leave
  # two of these behind together -- and fixed rather than documented, because
  # the agreement is free and the divergence would be silent.
  if [ -d "$op_repo/.git/rebase-merge" ]; then
    found="rebase"
  elif [ -d "$op_repo/.git/rebase-apply" ]; then
    if [ -f "$op_repo/.git/rebase-apply/applying" ]; then found="am"; else found="rebase"; fi
  elif [ -f "$op_repo/.git/CHERRY_PICK_HEAD" ]; then
    found="cherry-pick"
  elif [ -f "$op_repo/.git/REVERT_HEAD" ]; then
    found="revert"
  elif [ -f "$op_repo/.git/MERGE_HEAD" ]; then
    found="merge"
  elif [ -f "$op_repo/.git/BISECT_LOG" ]; then
    found="bisect"
  fi
  if [ "$found" != "$want" ]; then
    fail=$((fail + 1))
    printf 'FAIL %s: fixture is in %s, expected %s\n' \
      "$label" "${found:-nothing}" "${want:-nothing}" >&2
    return 1
  fi
  return 0
}

# 1 + 2. A conflicted rebase, from the checkout root and from a SUBDIRECTORY of
# it. The subdir row is the one that fences RESOLVING the git dir rather than
# assuming `<target_dir>/.git`: there, `$target_dir` is `<main>/sub`, which has
# no `.git` of its own.
opg rebase --merge other >/dev/null 2>&1
op_assert_inflight rebase "mid-REBASE fixture"
run_case_msg "detached MAIN mid-REBASE: remedy is 'rebase --abort', not 'switch main'" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m resolve"}}' "$op_repo")" \
  'rebase --abort' 'Re-attach first'
run_case_msg "detached MAIN mid-REBASE from a SUBDIR: remedy still 'rebase --abort'" 2 \
  "$(printf '{"cwd":"%s/sub","tool_input":{"command":"git commit -m resolve"}}' "$op_repo")" \
  'rebase --abort' 'Re-attach first'
# CONTROL, not a fence: the LINKED worktree is on a branch, so it exits at the
# branch-NAME arm and never reaches any of the new code. No mutation of the
# detection turns it red -- it is here to say the new arm changed nothing on the
# path a lane actually uses while the shared checkout is mid-rebase.
run_case "LINKED worktree while the MAIN checkout is mid-rebase: allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m wip"}}' "$op_wt")"
opg rebase --abort >/dev/null 2>&1

# 3. `git am`. `rebase-apply/` is shared by `git am` and `git rebase --apply`, so
# the directory alone cannot name the remedy -- the `applying` sentinel inside it
# is what does. This row pins the `am` direction; the `rebase --apply` direction
# is pinned in the resulting-HEAD block below, and it is the one that matters
# more, because it fails QUIETLY. Measured on git 2.53: `git rebase --abort`
# inside an am session is LOUD (rc=128, `fatal: It looks like 'git am' is in
# progress. Cannot rebase.`), while `git am --abort` inside a `rebase --apply`
# session exits 0 with no output and leaves HEAD DETACHED where the right remedy
# lands on `main`. An earlier version of this comment cited "No rebase in
# progress?" for the first crossing; that string is what git says when NOTHING is
# in progress, a different condition.
opg checkout -q --detach main
opg am "$FIXROOT/op-patches"/*.patch >/dev/null 2>&1
op_assert_inflight am "mid-AM text fixture"
run_case_msg "detached MAIN mid-AM: remedy is 'am --abort'" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m resolve"}}' "$op_repo")" \
  'am --abort' 'Re-attach first'
opg am --abort >/dev/null 2>&1

# 4-6. cherry-pick / merge / revert. Each is reachable here only from a tree that
# was ALREADY detached (on a branch, git leaves HEAD attached and the branch-NAME
# arm catches it), and each has its own marker file, so each needs its own row or
# deleting that branch of the detection survives.
opg checkout -q --detach main
opg cherry-pick other >/dev/null 2>&1
op_assert_inflight cherry-pick "mid-CHERRY-PICK text fixture"
run_case_msg "detached MAIN mid-CHERRY-PICK: remedy is 'cherry-pick --abort'" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m resolve"}}' "$op_repo")" \
  'cherry-pick --abort' 'Re-attach first'
opg cherry-pick --abort >/dev/null 2>&1

opg checkout -q --detach main
opg merge other >/dev/null 2>&1
op_assert_inflight merge "mid-MERGE text fixture"
run_case_msg "detached MAIN mid-MERGE: remedy is 'merge --abort'" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m resolve"}}' "$op_repo")" \
  'merge --abort' 'Re-attach first'
opg merge --abort >/dev/null 2>&1

opg checkout -q --detach main
opg revert --no-edit other >/dev/null 2>&1
op_assert_inflight revert "mid-REVERT text fixture"
run_case_msg "detached MAIN mid-REVERT: remedy is 'revert --abort'" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m resolve"}}' "$op_repo")" \
  'revert --abort' 'Re-attach first'
opg revert --abort >/dev/null 2>&1

# 7. bisect, the one operation git does NOT refuse a `switch main` during -- it
# switches with a warning and leaves the bisect running. So the old wording was
# not a dead end here, only incomplete, and the remedy has a different SHAPE
# (`bisect reset`, no `--continue` / `--abort` pair), so this row forbids BOTH
# the generic operation wording and the fallback one.
opg checkout -q main
opg bisect start >/dev/null 2>&1
opg bisect bad >/dev/null 2>&1
opg bisect good "$op_root" >/dev/null 2>&1
op_assert_inflight bisect "mid-BISECT text fixture"
run_case_msg "detached MAIN mid-BISECT: remedy is 'bisect reset'" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m resolve"}}' "$op_repo")" \
  'bisect reset' '--abort' 'Re-attach first'
opg bisect reset >/dev/null 2>&1

# 8. NOTHING in progress: the fallback wording is the one that must survive, and
# it is the row that says the detection is a discriminator rather than a rewrite.
opg checkout -q --detach main
op_assert_inflight "" "NOTHING-in-progress fixture"
run_case_msg "detached MAIN, NOTHING in progress: remedy stays 'switch main'" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m oops"}}' "$op_repo")" \
  'Re-attach first: git -C' '--abort' 'rebase --continue'
opg checkout -q main

# --- THE REMEDY'S RESULTING HEAD (go-to-k/cdkd#2402 review round 3) -----------
#
# The block above asserts the remedy TEXT, and its header recorded that every
# printed remedy had been RUN and exited 0. Both were true and the message was
# still wrong: it promised `--abort` would "abandon it and re-attach", which
# happens in exactly one of the six operations. Measured on git 2.53, each
# printed remedy run verbatim against a detached MAIN checkout, HEAD read
# afterwards -- every one rc=0:
#
#   cherry-pick --abort   before DETACHED   after DETACHED
#   revert      --abort   before DETACHED   after DETACHED
#   merge       --abort   before DETACHED   after DETACHED
#   am          --abort   before DETACHED   after DETACHED
#   rebase      --abort   before DETACHED   after main       (started FROM main)
#   rebase      --abort   before DETACHED   after DETACHED   (started detached)
#   bisect reset          before DETACHED   after main
#
# EXIT STATUS WAS THE WRONG OBSERVABLE. Nine remedies exiting 0 is exactly what
# a message that leaves the user one step short also looks like, and no row here
# asserted the right thing, which is how the wording survived the round that
# checked all nine. The rows below RUN the printed command and assert where HEAD
# lands, beside the sentence the message claims about it -- so the claim and the
# outcome are pinned to each other and cannot drift apart again.
#
# WHAT EACH ROW HOLDS DOWN, measured by mutating the hook and re-running this
# suite (cdkd numbers; the siblings differ only in the pre-existing case count):
#
#   restore `# to abandon it and re-attach`, drop the conditional -> 7.
#     Every `--abort` row. The BISECT rows SURVIVE, because `bisect reset` is a
#     separate arm with its own wording that this mutation does not touch.
#     THAT SURVIVAL WAS ONCE RECORDED HERE AS "the honest number", and it is --
#     about the mutation it survived. It was then read as though it also said
#     the bisect arm's own claim held, which it never said: the arm was
#     asserting `bisect reset` "restores the branch you started from" in BOTH
#     start polarities, and that is false in one of them. A row surviving a
#     mutation aimed somewhere else is evidence about that mutation only. What
#     was missing was a row in the other polarity, and the two below are it.
#   force `reattach_to=""`, never reading `head-name`             -> 2.
#     The two rebase-started-FROM-a-branch rows, one per backend.
#   force `reattach_to="main"` whenever a rebase is in progress   -> 1.
#     The rebase-started-DETACHED row, and only it.
#   `rebase-apply` branch of the sentinel set to `am`             -> 1.
#     The `rebase --apply` row -- the branch the `am`-direction row above
#     cannot see, and the one whose wrong answer is silent.
#   never read `BISECT_START` (bisect `reattach_to` stays empty)  -> 1.
#     The bisect-started-FROM-a-branch row, and only it.
#   treat `BISECT_START` as a branch name unconditionally         -> 1.
#     The bisect-started-DETACHED row, and only it.
#   restore the old blanket bisect wording                        -> 2.
#     Both bisect rows -- the twin of the first mutation above, one arm over.
#
# All seven tallies are identical in cdkd, cdk-local and cdk-real-drift
# (7 / 2 / 1 / 1 / 1 / 1 / 2), measured the same way. The first four are
# unchanged from the previous round; the last three are this round's.
#
# The fixture is `op_repo` again, left on `main` by the block above. Each row
# builds its own state; running the printed remedy IS the assertion, and the
# teardown is a separate, explicit step -- see `op_reset` immediately below for
# why it cannot be the remedy itself.

# EACH ROW TEARS DOWN EXPLICITLY rather than relying on "the printed remedy
# cleaned up". The remedy IS the assertion here, so a mutant that stops printing
# one leaves the fixture MID-OPERATION and every row after it then fails for a
# reason that is not its own. Measured before this helper existed: dropping the
# `applying` sentinel red-lined the `am` row (correctly) and then cherry-pick,
# revert, merge and bisect (cascade) -- 6 rows for a defect that touches 1. A
# tally that cannot be attributed to a row is not a fence, it is noise.
#
# It also VERIFIES that it cleaned up, because `git am` and `git rebase --apply`
# SHARE `.git/rebase-apply`: if an abort leaves that directory behind, the next
# `git am` refuses to start ("previous rebase directory ... still exists") and
# the row that follows measures the RESIDUE instead of its own operation. That
# is not hypothetical -- it is how this suite went green on git 2.53 locally and
# red on the CI runner's older git, where the printed `am --abort` exited 128
# against a rebase-apply directory no am session owned. A fixture that cannot
# assert its own precondition reports the wrong defect.
op_reset() {
  opg rebase --abort >/dev/null 2>&1
  opg am --abort >/dev/null 2>&1
  opg cherry-pick --abort >/dev/null 2>&1
  opg revert --abort >/dev/null 2>&1
  opg merge --abort >/dev/null 2>&1
  opg bisect reset >/dev/null 2>&1
  opg checkout -q --force main >/dev/null 2>&1
  # DEFENCE, not a fence: no mutation on this machine reddens the two lines
  # below, because git 2.53's own `--abort` already removes them. They exist for
  # the git the CI runner has, where it did not. Labelled rather than counted.
  rm -rf "$op_repo/.git/rebase-apply" "$op_repo/.git/rebase-merge" 2>/dev/null
  rm -f "$op_repo/.git/CHERRY_PICK_HEAD" "$op_repo/.git/REVERT_HEAD" \
        "$op_repo/.git/MERGE_HEAD" "$op_repo/.git/BISECT_LOG" 2>/dev/null
  :
}

# 1. rebase (merge backend) started FROM `main`: the ONE arm where `--abort`
# really does re-attach, and the row that pins the `head-name` READ.
opg rebase --merge other >/dev/null 2>&1
op_assert_inflight rebase "mid-REBASE-from-main fixture"
run_case_head "mid-REBASE from main: 'rebase --abort' lands on main, and says so" \
  "$op_repo" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m resolve"}}' "$op_repo")" \
  'rebase --abort' 'branch main' "Either ending re-attaches HEAD to 'main'" 'NEITHER ending'
op_reset

# 2. The SAME operation started while ALREADY detached. Same `in progress`, same
# printed remedy, OPPOSITE outcome -- so a blanket sentence is wrong even inside
# `rebase`, and git's own `head-name` (the literal `detached HEAD` here, against
# `refs/heads/main` above) is the only thing that tells the two apart.
opg checkout -q --detach main
opg rebase --merge other >/dev/null 2>&1
op_assert_inflight rebase "mid-REBASE-started-detached fixture"
run_case_head "mid-REBASE started DETACHED: 'rebase --abort' stays detached, and says so" \
  "$op_repo" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m resolve"}}' "$op_repo")" \
  'rebase --abort' 'DETACHED' 'NEITHER ending re-attaches HEAD' 'Either ending'
op_reset

# 3. `git rebase --apply` -- the branch of the `rebase-apply` sentinel that NO
# row reached before. Mutating it to `inflight="am"`, the inverse of the `am`
# direction the block above pins, left all three suites fully green. It is the
# direction worth a row because it fails QUIETLY: measured on git 2.53 from this
# state, `git am --abort` exits 0 with no output and leaves HEAD DETACHED, where
# `git rebase --abort` lands on `main`. The reverse crossing is loud (rc=128,
# `fatal: It looks like 'git am' is in progress. Cannot rebase.`).
opg rebase --apply other >/dev/null 2>&1
op_assert_inflight rebase "mid-REBASE--apply fixture"
run_case_head "mid-REBASE --apply: remedy is 'rebase --abort', never 'am --abort'" \
  "$op_repo" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m resolve"}}' "$op_repo")" \
  'rebase --abort' 'branch main' "Either ending re-attaches HEAD to 'main'" 'am --abort'
op_reset

# 4-7. am / cherry-pick / revert / merge -- the four the old wording got wrong.
# None of them detaches HEAD itself, so this arm is reachable for them only from
# an ALREADY-detached tree, and `--abort` restores exactly that.
opg checkout -q --detach main
opg am "$FIXROOT/op-patches"/*.patch >/dev/null 2>&1
op_assert_inflight am "mid-AM fixture"
run_case_head "mid-AM: 'am --abort' leaves HEAD DETACHED, and says so" \
  "$op_repo" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m resolve"}}' "$op_repo")" \
  'am --abort' 'DETACHED' 'NEITHER ending re-attaches HEAD' 'Either ending'
op_reset

opg checkout -q --detach main
opg cherry-pick other >/dev/null 2>&1
op_assert_inflight cherry-pick "mid-CHERRY-PICK fixture"
run_case_head "mid-CHERRY-PICK: 'cherry-pick --abort' leaves HEAD DETACHED, and says so" \
  "$op_repo" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m resolve"}}' "$op_repo")" \
  'cherry-pick --abort' 'DETACHED' 'NEITHER ending re-attaches HEAD' 'Either ending'
op_reset

opg checkout -q --detach main
opg revert --no-edit other >/dev/null 2>&1
op_assert_inflight revert "mid-REVERT fixture"
run_case_head "mid-REVERT: 'revert --abort' leaves HEAD DETACHED, and says so" \
  "$op_repo" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m resolve"}}' "$op_repo")" \
  'revert --abort' 'DETACHED' 'NEITHER ending re-attaches HEAD' 'Either ending'
op_reset

opg checkout -q --detach main
opg merge other >/dev/null 2>&1
op_assert_inflight merge "mid-MERGE fixture"
run_case_head "mid-MERGE: 'merge --abort' leaves HEAD DETACHED, and says so" \
  "$op_repo" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m resolve"}}' "$op_repo")" \
  'merge --abort' 'DETACHED' 'NEITHER ending re-attaches HEAD' 'Either ending'
op_reset

# 8 + 9. bisect, whose remedy has a different SHAPE (`bisect reset`, with no
# `--continue` / `--abort` pair) and whose message makes its own claim about
# HEAD. TWO rows, one per START polarity, for the reason rows 1 and 2 are two
# rows: the same operation, the same printed remedy, the opposite outcome.
opg bisect start >/dev/null 2>&1
opg bisect bad >/dev/null 2>&1
opg bisect good "$op_root" >/dev/null 2>&1
# 8. Started FROM a branch: `bisect reset` really does re-attach, and the
# message says so. This is the polarity the arm was written for, and the only
# one it had ever been asked about.
op_assert_inflight bisect "mid-BISECT-from-branch fixture"
run_case_head "mid-BISECT from main: 'bisect reset' lands on main, and says so" \
  "$op_repo" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m resolve"}}' "$op_repo")" \
  'bisect reset' 'branch main' "restores the branch you started from, 'main'" \
  'does NOT re-attach'
op_reset

# 9. THE SAME operation started while ALREADY DETACHED -- and this is the row
# whose absence let the bisect arm repeat, verbatim, the defect rows 1 and 2
# fixed for rebase. The old wording said the bisect "is what detached HEAD here"
# and that `bisect reset` "restores the branch you started from"; both are false
# from a tree that was already detached, and `main-tree-branch-gate.sh` passes
# `git checkout <sha>` in the main checkout, so that state is one allowed
# command away. Measured on git 2.53, same fixture both ways:
#
#   started FROM a branch   BISECT_START = main    reset -> branch main
#   started DETACHED        BISECT_START = <sha>   reset -> rc=0, STILL DETACHED
#
# The user reads exit 0 as success and the next gated command blocks again with
# `in progress : nothing` -- the dead end the resulting-HEAD work exists to
# remove, surviving in the one arm that work had not reached.
#
# WHY THE OLD BISECT ROW DID NOT CATCH IT, and it is worth stating because that
# row was read as evidence: it SURVIVES the "restore the blanket wording"
# mutation, and the block below recorded that survival as "the honest number".
# It is honest about what it measured -- the bisect arm is separate wording, so
# a mutation of the `--abort` sentence does not touch it -- but a row surviving
# a mutation aimed elsewhere says nothing about whether its OWN claim holds. The
# only thing that could have caught this was a row in the other polarity, and
# there was none. A surviving row is not automatically an honest one; it is
# honest only about the mutation it survived.
opg checkout -q --detach main
opg bisect start >/dev/null 2>&1
opg bisect bad >/dev/null 2>&1
opg bisect good "$op_root" >/dev/null 2>&1
op_assert_inflight bisect "mid-BISECT-detached fixture"
run_case_head "mid-BISECT started DETACHED: 'bisect reset' stays detached, and says so" \
  "$op_repo" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m resolve"}}' "$op_repo")" \
  'bisect reset' 'DETACHED' 'does NOT re-attach HEAD' \
  'restores the branch you started from'
op_reset
echo
echo "Pass: $pass  Fail: $fail"
if [[ "$fail" -gt 0 ]]; then
  echo
  printf '%b' "$fail_log"
  exit 1
fi
