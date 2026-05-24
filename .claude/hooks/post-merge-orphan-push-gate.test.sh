#!/usr/bin/env bash
# Smoke test for post-merge-orphan-push-gate.sh.
#
# Mocks the `gh` binary via $GH_BIN so each case can dictate the
# `gh pr list ... --json ...` JSON response without touching network.
# The mock script writes a JSON array to stdout and exits 0 (or exits
# non-zero to simulate `gh` failure / missing-auth).
#
# Run from the repo root: `bash .claude/hooks/post-merge-orphan-push-gate.test.sh`.

set -u

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/post-merge-orphan-push-gate.sh"

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

# Fixture git worktree on a feature branch (so `symbolic-ref --short HEAD`
# returns a non-empty branch name).
feature_repo="$TMPDIR/feature-repo"
git init -q -b feat/already-merged "$feature_repo"
git -C "$feature_repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init

# Helper to write a per-case mock `gh` binary. Takes one arg: the JSON
# the mock should emit (or the literal string "FAIL" to make `gh` exit
# non-zero, simulating auth/network failure).
make_gh_mock() {
  local json="$1"
  local path="$TMPDIR/gh-mock-$$-$RANDOM"
  cat > "$path" <<EOF_MOCK
#!/usr/bin/env bash
# Mock gh — emit a fixed JSON response or fail.
if [ "$json" = "FAIL" ]; then
  echo "gh: not authenticated" >&2
  exit 1
fi
cat <<'EOF_JSON'
$json
EOF_JSON
EOF_MOCK
  chmod +x "$path"
  printf '%s\n' "$path"
}

pass=0
fail=0
fail_log=""

# run_case <name> <expect_exit> <payload> <gh-mock-json-or-FAIL-or-NOMOCK>
run_case() {
  local name="$1"; local want="$2"; local payload="$3"; local mock_arg="$4"
  local got out gh_bin=""

  if [ "$mock_arg" != "NOMOCK" ]; then
    gh_bin=$(make_gh_mock "$mock_arg")
  fi

  # Single run, capture both stdout/stderr and exit status.
  if [ -n "$gh_bin" ]; then
    out=$(printf '%s' "$payload" | GH_BIN="$gh_bin" "$HOOK" 2>&1)
    got=$?
  else
    # Force PATH to a sanitised set that has the standard utilities
    # (bash / jq / git / awk / grep / mktemp) but excludes any `gh`
    # binary — exercises the "gh not installed" pass-through. We do
    # this by building a tmp PATH dir of symlinks to the basics, then
    # using that as the sole entry. $TMPDIR (the test's per-run scratch
    # dir) already exists, so we sit a sibling no-gh dir next to it.
    no_gh_dir="$TMPDIR/no-gh-path"
    if [ ! -d "$no_gh_dir" ]; then
      mkdir -p "$no_gh_dir"
      for util in bash jq git awk grep mktemp cat printf; do
        src=$(command -v "$util" 2>/dev/null || true)
        [ -n "$src" ] && ln -sf "$src" "$no_gh_dir/$util"
      done
    fi
    out=$(printf '%s' "$payload" | PATH="$no_gh_dir" GH_BIN="" "$HOOK" 2>&1)
    got=$?
  fi

  if [ "$got" = "$want" ]; then
    pass=$((pass + 1))
    printf 'OK   %s (exit %s)\n' "$name" "$got"
  else
    fail=$((fail + 1))
    fail_log+="FAIL $name: want exit $want, got $got\n"
    fail_log+="  payload : $payload\n"
    fail_log+="  mock-arg: $mock_arg\n"
    fail_log+="  output  : $out\n"
    printf 'FAIL %s (want %s, got %s)\n' "$name" "$want" "$got"
  fi
}

branch="feat/already-merged"
payload_default_push() {
  printf '{"cwd":"%s","tool_input":{"command":"git push origin %s"}}' "$feature_repo" "$branch"
}

# --- Case 1: gh returns empty array — push allowed ---
run_case "empty gh response → push allowed" 0 \
  "$(payload_default_push)" \
  "[]"

# --- Case 2: gh returns an open PR (state filter still respected by mock;
# defensive: even if it leaks, our hook only queries `--state merged`,
# so the mock case where merged is empty also covers this) — push allowed ---
run_case "no merged PR (open-only) → push allowed" 0 \
  "$(payload_default_push)" \
  "[]"

# --- Case 3: gh returns a MERGED PR whose headRefName matches — BLOCK ---
merged_match='[{"number":263,"mergedAt":"2026-05-11T03:00:00Z","headRefName":"feat/already-merged","title":"feat: cool stuff"}]'
run_case "merged PR with matching head → push BLOCKED" 2 \
  "$(payload_default_push)" \
  "$merged_match"

# --- Case 4: gh returns a MERGED PR but with a different headRefName
# (defensive) — push allowed ---
merged_mismatch='[{"number":999,"mergedAt":"2026-05-11T03:00:00Z","headRefName":"some/other-branch","title":"unrelated"}]'
run_case "merged PR with different head (defensive) → push allowed" 0 \
  "$(payload_default_push)" \
  "$merged_mismatch"

# --- Case 5: gh returns no MERGED PR for this branch (closed-not-merged
# would also surface as empty under our `--state merged` filter) — push
# allowed. We emit an empty array to simulate that. ---
run_case "closed-not-merged PR (empty under merged filter) → push allowed" 0 \
  "$(payload_default_push)" \
  "[]"

# --- Case 6: push to a non-origin remote → pass through regardless of
# PR state. The mock will be ignored because the hook short-circuits
# before calling gh. ---
non_origin_payload=$(printf '{"cwd":"%s","tool_input":{"command":"git push upstream %s"}}' "$feature_repo" "$branch")
run_case "push to non-origin remote → pass through" 0 \
  "$non_origin_payload" \
  "$merged_match"

# --- Case 7: `git -C <path> push` form — respect the -C cwd. We point
# -C at the feature repo while the payload's cwd is somewhere else, so
# the only way the branch resolves correctly is via -C. With a matching
# merged PR mock, this should BLOCK. ---
gc_payload=$(printf '{"cwd":"%s","tool_input":{"command":"git -C %s push origin %s"}}' "$TMPDIR" "$feature_repo" "$branch")
run_case "git -C <feature-repo> push → respects -C cwd" 2 \
  "$gc_payload" \
  "$merged_match"

# --- Case 8: `cd <path> && git push` form — respect the cd target.
# Same as case 7 but via cd. We push without a positional branch so the
# hook must `symbolic-ref --short HEAD` against the cd target. ---
cd_payload=$(printf '{"cwd":"%s","tool_input":{"command":"cd %s && git push"}}' "$TMPDIR" "$feature_repo")
run_case "cd <feature-repo> && git push → respects cd target" 2 \
  "$cd_payload" \
  "$merged_match"

# --- Case 9: gh not installed (or auth failure) — pass through with a
# stderr debug note, never block. We pass NOMOCK + a PATH that contains
# no `gh` binary; the hook's `command -v gh` branch fails and we exit 0. ---
run_case "gh not installed → pass through" 0 \
  "$(payload_default_push)" \
  "NOMOCK"

# --- Bonus: gh returns an error (auth failure) → pass through ---
run_case "gh exits non-zero → pass through" 0 \
  "$(payload_default_push)" \
  "FAIL"

# --- Bonus: non-git command never enters the hook gate ---
run_case "non-push command always allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"ls -la"}}' "$feature_repo")" \
  "$merged_match"

# --- Bonus: git status (not push) — pass through ---
run_case "git status → pass through" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git status"}}' "$feature_repo")" \
  "$merged_match"

# --- Bonus: push with -u flag, branch resolved from current HEAD ---
u_payload=$(printf '{"cwd":"%s","tool_input":{"command":"git push -u origin"}}' "$feature_repo")
run_case "git push -u origin (no branch arg) → resolves from HEAD, blocks" 2 \
  "$u_payload" \
  "$merged_match"

# --- Bonus: branch deletion via colon refspec — pass through ---
del_payload=$(printf '{"cwd":"%s","tool_input":{"command":"git push origin :%s"}}' "$feature_repo" "$branch")
run_case "git push origin :branch (deletion) → pass through" 0 \
  "$del_payload" \
  "$merged_match"

# --- LINE-START ANCHORING cases (issue #563) ---
#
# The matcher MUST NOT fire when the literal substring `git push`
# appears inside a quoted argument body of an unrelated command.
# Per memory rule feedback_hook_command_match_line_start.md, applied
# to post-merge-orphan-push-gate.sh in issue #563 (mirroring the
# PR #562 fix to check-gate.sh).

# `gh issue create --body "...git push..."`: the body mentions
# `git push` but the command itself starts with `gh`. MUST pass
# through (would otherwise block routine issue creation even when
# the branch IS a merged-PR head).
fp_body_payload=$(printf '{"cwd":"%s","tool_input":{"command":"gh issue create --body \"remember to git push after merge\""}}' "$feature_repo")
run_case "gh issue body quoting 'git push' passes through" 0 \
  "$fp_body_payload" \
  "$merged_match"

# `echo "...git push..."`: the body mentions `git push` but the
# command starts with `echo`. MUST pass through.
fp_echo_payload=$(printf '{"cwd":"%s","tool_input":{"command":"echo \"warning: git push to merged branch creates orphan\""}}' "$feature_repo")
run_case "echo body quoting 'git push' passes through" 0 \
  "$fp_echo_payload" \
  "$merged_match"

echo
echo "Pass: $pass  Fail: $fail"
if [ "$fail" -gt 0 ]; then
  echo
  printf '%b' "$fail_log"
  exit 1
fi
