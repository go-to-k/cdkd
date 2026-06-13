#!/usr/bin/env bash
# Smoke test for integ-local-gate.sh.
#
# Exercises the cwd-aware command-matching against fixture git
# working trees, asserting the matcher correctly distinguishes
# gated commands (gh pr merge / git merge) from pass-through ones
# (gh pr create / git status / etc.). The marker-freshness branch
# is exercised end-to-end against the repo's own markgate state.
#
# Run from the repo root: `bash .claude/hooks/integ-local-gate.test.sh`.

set -u

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/integ-local-gate.sh"

# Per-run scratch dir; cleaned on EXIT.
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

# A fixture git working tree on a feature branch. The hook never
# itself touches the branch, but `git -C` checks (rev-parse --git-dir)
# need a real repo to pass.
fixture_repo="$TMPDIR/fixture-repo"
git init -q -b feature/x "$fixture_repo"
git -C "$fixture_repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init

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

# --- PASS-THROUGH cases (matcher must NOT fire) ---

# 1. Non-merge git command always passes through.
run_case "git status always allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git status"}}' "$fixture_repo")"

# 2. `gh pr create` is intentionally NOT gated.
run_case "gh pr create always allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr create --title foo"}}' "$fixture_repo")"

# 3. `gh pr view` is not gated.
run_case "gh pr view always allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr view 42"}}' "$fixture_repo")"

# 4. `gh pr edit` is not gated.
run_case "gh pr edit always allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr edit 42 --title bar"}}' "$fixture_repo")"

# 5. Non-git-repo target dir → silent pass (we can't audit what we
#    can't see; mirrors branch-gate.sh).
run_case "non-git target dir allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr merge"}}' "$TMPDIR")"

# 6. Plain `ls` passes through.
run_case "non-gh non-git command allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"ls -la"}}' "$fixture_repo")"

# 7. Empty stdin → cmd empty → allowed (nothing to gate).
run_case "empty stdin allowed" 0 \
  ''

# --- MATCHER cases (hook MUST fire and reach the markgate check) ---
#
# We can't easily mock markgate's output, but we CAN verify the hook
# reaches the markgate step rather than short-circuiting at the
# command-matcher. The fixture repo is not the cdkd repo (no
# .markgate.yml), so markgate verify will fail — exit 2 is the
# expected "matched + marker stale or unavailable" outcome.

# 8. `gh pr merge` matches.
run_case "gh pr merge matches (gate fires → exit 2)" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr merge"}}' "$fixture_repo")"

# 9. `gh pr merge --auto` matches.
run_case "gh pr merge --auto matches" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr merge --auto"}}' "$fixture_repo")"

# 10. `git merge <branch>` matches.
run_case "git merge <branch> matches" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git merge origin/main"}}' "$fixture_repo")"

# 11. `cd <fixture> && gh pr merge` resolves via cd target.
run_case "cd <fixture> && gh pr merge matches" 2 \
  "$(printf '{"cwd":"/tmp","tool_input":{"command":"cd %s && gh pr merge"}}' "$fixture_repo")"

# 12. `git -C <fixture> merge` resolves via -C.
run_case "git -C <fixture> merge matches" 2 \
  "$(printf '{"cwd":"/tmp","tool_input":{"command":"git -C %s merge origin/main"}}' "$fixture_repo")"

# 13. `gh -C <fixture> pr merge` resolves via gh -C (cdkd #559).
#     Previously this hook only parsed `git -C`; the #559 fix adds
#     parallel `gh -C` parsing so cross-worktree gh invocations route
#     to the right markgate state.
run_case "gh -C <fixture> pr merge matches" 2 \
  "$(printf '{"cwd":"/tmp","tool_input":{"command":"gh -C %s pr merge"}}' "$fixture_repo")"

# 14. `gh -C <side> pr merge --auto` from main-cwd → routes to side.
side_repo="$TMPDIR/side-repo"
git init -q -b feature/y "$side_repo"
git -C "$side_repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
run_case "gh -C <side> pr merge --auto from main cwd" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh -C %s pr merge --auto"}}' "$fixture_repo" "$side_repo")"

# --- LINE-START ANCHORING cases (issue #563) ---
#
# The matcher MUST NOT fire when the literal substrings `gh pr merge`
# / `git merge` appear inside a quoted argument body of an unrelated
# command. Per memory rule feedback_hook_command_match_line_start.md,
# applied to integ-local-gate.sh in issue #563 (mirroring the PR #562
# fix to check-gate.sh).

# 15. `gh issue create --body "...gh pr merge..."`: body mentions
#     `gh pr merge` but the line starts with `gh issue create`.
#     MUST pass through.
run_case "gh issue body quoting 'gh pr merge' passes through" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh issue create --body \"next step: gh pr merge --squash\""}}' "$fixture_repo")"

# 16. `echo "...git merge..."`: body mentions `git merge` but the
#     command starts with `echo`. MUST pass through.
run_case "echo body quoting 'git merge' passes through" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"echo \"reminder: git merge origin/main when ready\""}}' "$fixture_repo")"

# --- PR-DIFF SCOPE-CHECK cases (mirrors integ-destroy / integ-broad gates) ---
#
# For `gh pr merge <N>` WITH a PR number, the gate fetches the PR's file
# list via `gh pr view <N> --json files` and passes through when no file
# touches local-execution scope (src/local/** / src/cli/commands/local-*.ts
# / tests/integration/local-*). A stub `gh` on PATH returns a controlled
# file list; the real markgate (stale in this checkout) drives the
# fires-when-relevant case to exit 2.
GH_STUB_DIR="$TMPDIR/ghstub"
mkdir -p "$GH_STUB_DIR"
GH_FILES_PAYLOAD="$TMPDIR/gh-files.json"
cat > "$GH_STUB_DIR/gh" <<'GH_EOF'
#!/usr/bin/env bash
if [ "${1:-} ${2:-}" = "pr view" ]; then
  if [ "${GH_STUB_FAIL:-}" = "1" ]; then exit 1; fi
  cat "$GH_FILES_PAYLOAD"
  exit 0
fi
exit 0
GH_EOF
chmod +x "$GH_STUB_DIR/gh"
export GH_FILES_PAYLOAD
OLD_PATH="$PATH"
export PATH="$GH_STUB_DIR:$PATH"

# 17. PR with a number whose files are all NON-local -> scope check
#     passes the merge through (exit 0) even though integ-local is stale.
printf '{"files":[{"path":"src/provisioning/cloud-control-provider.ts"},{"path":"docs/changelog-cdkd.md"}]}' > "$GH_FILES_PAYLOAD"
GH_STUB_FAIL="" run_case "gh pr merge <N> non-local files passes through" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr merge 999 --squash --delete-branch"}}' "$fixture_repo")"

# 18. PR with a number whose files include a local-execution file ->
#     scope check engages, the (stale) marker blocks the merge (exit 2).
printf '{"files":[{"path":"src/local/docker-runner.ts"},{"path":"docs/changelog-cdkd.md"}]}' > "$GH_FILES_PAYLOAD"
GH_STUB_FAIL="" run_case "gh pr merge <N> with src/local file gate fires" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr merge 999 --squash"}}' "$fixture_repo")"

# 19. PR with a number whose files include a tests/integration/local-*
#     fixture -> scope check engages, stale marker blocks (exit 2).
printf '{"files":[{"path":"tests/integration/local-invoke/verify.sh"}]}' > "$GH_FILES_PAYLOAD"
GH_STUB_FAIL="" run_case "gh pr merge <N> with tests/integration/local- file gate fires" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr merge 999"}}' "$fixture_repo")"

# 20. `gh pr view` failure -> fail-open (exit 0), an infra outage must
#     not block merges (mirrors integ-broad-gate.sh).
printf '{"files":[{"path":"src/local/docker-runner.ts"}]}' > "$GH_FILES_PAYLOAD"
GH_STUB_FAIL="1" run_case "gh pr view failure fails open" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr merge 999 --squash"}}' "$fixture_repo")"

export PATH="$OLD_PATH"

echo
echo "Pass: $pass  Fail: $fail"
if [[ "$fail" -gt 0 ]]; then
  echo
  printf '%b' "$fail_log"
  exit 1
fi
