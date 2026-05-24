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

# Per-run scratch dir; cleaned on EXIT.
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

# Two fixture git working trees: one on `main`, one on a feature branch.
# Both have a config user so commit works if we ever exercise it.
main_repo="$TMPDIR/main-repo"
feature_repo="$TMPDIR/feature-repo"
git init -q -b main "$main_repo"
git -C "$main_repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
git init -q -b feature/x "$feature_repo"
git -C "$feature_repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init

pass=0
fail=0
fail_log=""

# run_case <name> <expect_exit> <stdin_json>
run_case() {
  local name="$1"; local want="$2"; local payload="$3"
  local got out
  out=$(printf '%s' "$payload" | "$HOOK" 2>&1) || true
  got=$?
  # The above always evaluates to 0 (`|| true`), so capture status
  # via a separate run.
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
    printf 'FAIL %s (want %s, got %s)\n' "$name" "$want" "$got"
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

# 6. Detached HEAD / non-git dir → symbolic-ref empty → allow (we can't
#    gate what we can't see).
run_case "non-git target dir allowed (silent pass)" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m wip"}}' "$TMPDIR")"

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

# 8. git push on main blocked too.
run_case "git push on main blocked" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git push origin main"}}' "$main_repo")"

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
#     matcher fires on the FIRST `git -C <feature> status` token
#     (the line-start one), which is not a commit/push subcommand,
#     so the hook short-circuits at the matcher (exit 0). This is
#     an ACCEPTED FALSE-NEGATIVE of the line-start tightening — the
#     trade-off we make to eliminate quoted-body false-positives
#     (see Part C false-positive cases below). For the agent
#     workflow this is fine: chained-on-one-line commits to main
#     are rare; the dominant shape is `cd <repo> && git commit ...`,
#     which IS line-start matched.
run_case "single-line chained git -C status; git -C commit (accepted false-negative)" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git -C %s status; git -C %s commit -m oops"}}' "$feature_repo" "$feature_repo" "$main_repo")"

# 11b. `git -c <key>=<val> commit` — global `-c` flag before commit
#      subcommand. The tightened regex must not get confused by the
#      `<key>=<val>` token (which can contain the literal substring
#      `commit`, e.g. `commit.gpgSign=false`).
run_case "git -c commit.gpgSign=false commit on main blocked" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git -c commit.gpgSign=false commit -m oops"}}' "$main_repo")"

# 11c. `git push --force` on main — `--force` after the subcommand.
run_case "git push --force on main blocked" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git push origin --force"}}' "$main_repo")"

# --- Edge cases ---

# 12. Missing .cwd in payload → fall back to hook process $PWD.
#    Not exercised end-to-end (we'd need to control $PWD); just
#    confirm the hook does not crash on missing cwd.
run_case "missing .cwd does not crash" 0 \
  '{"tool_input":{"command":"git status"}}'

# 13. Empty stdin payload → cmd empty → allowed (nothing to gate).
run_case "empty stdin allowed" 0 \
  ''

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

echo
echo "Pass: $pass  Fail: $fail"
if [[ "$fail" -gt 0 ]]; then
  echo
  printf '%b' "$fail_log"
  exit 1
fi
