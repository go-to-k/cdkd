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
# bash 3.2 is NOT exercised on the HOOK by running THIS FILE under /bin/bash.
# The hook's shebang is `#!/usr/bin/env bash`, which resolves through PATH and
# finds whatever bash is first there -- Homebrew 5.x on a dev Mac -- so
# `/bin/bash <suite>` measured the SUITE under 3.2 and the SUBJECT under 5.x.
# `HOOK_BASH` puts a `bash` shim first on PATH so the shebang, the explicit
# `bash "$HOOK"` calls, and any `bash` the hook itself spawns all follow the
# harness. Proved load-bearing rather than assumed: injecting a `;;&` (a bash
# 4+ case terminator) into the hook reddens cases only WITH the shim in place.
if [ -n "${HOOK_BASH:-}" ]; then
  # Resolved to an ABSOLUTE path first: `HOOK_BASH=bash` would otherwise make
  # `ln -sf bash <shim>/bash` a symlink pointing at ITSELF, and every hook
  # invocation would die on ELOOP -- a suite-wide red with a cause nowhere near
  # the hook.
  HOOK_BASH_BIN="$(command -v "$HOOK_BASH" 2>/dev/null || printf '%s' "$HOOK_BASH")"
  case "$HOOK_BASH_BIN" in /*) ;; *) HOOK_BASH_BIN="$PWD/$HOOK_BASH_BIN" ;; esac
  HOOK_BASH_SHIM="$TMPDIR/bash32-shim"
  mkdir -p "$HOOK_BASH_SHIM"
  ln -sf "$HOOK_BASH_BIN" "$HOOK_BASH_SHIM/bash"
  PATH="$HOOK_BASH_SHIM:$PATH"
  export PATH
fi
# PRINTED, not merely honoured: a suite that does not say which interpreter it
# measured cannot be read as evidence about either one.
printf 'hook interpreter: %s (bash %s)\n' \
  "$(command -v bash)" "$(bash -c 'echo "$BASH_VERSION"')"


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

# The FLAG spellings of the same deletion. `--delete` used to sit in the
# valueless-flag group of the token walk, so it was skipped and the branch
# name after it was read as a positional -- making the command parse
# identically to a content push and get refused, while the deletion check's
# own comment claimed this form passed through. Deleting a merged branch is
# the routine post-merge cleanup, so the false positive fired on exactly the
# workflow the gate exists to support.
del_flag_payload=$(printf '{"cwd":"%s","tool_input":{"command":"git push origin --delete %s"}}' "$feature_repo" "$branch")
run_case "git push origin --delete branch → pass through" 0 \
  "$del_flag_payload" \
  "$merged_match"

del_short_payload=$(printf '{"cwd":"%s","tool_input":{"command":"git push origin -d %s"}}' "$feature_repo" "$branch")
run_case "git push origin -d branch → pass through" 0 \
  "$del_short_payload" \
  "$merged_match"

# Polarity control: the same branch, same mocked merged-PR response, WITHOUT
# a deletion flag, must still be refused. Without this the two cases above
# are satisfied by a gate that stopped firing for any reason at all -- the
# failure mode this session hit four separate times.
del_control_payload=$(printf '{"cwd":"%s","tool_input":{"command":"git push origin %s"}}' "$feature_repo" "$branch")
run_case "git push origin branch (no deletion flag) → still blocks" 2 \
  "$del_control_payload" \
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
# --- CROSS-REPO: the merged-PR lookup must target the PUSH TARGET -----------
# Measured 2026-08-25: this gate refused a push to cdk-real-drift (PR OPEN)
# citing go-to-k/cdkd#2195 (MERGED), because `gh pr list` ran with no `cd` and
# so resolved THIS session's repo, and both repos had a branch named
# `chore/issue-dup-check`. These repos name branches by convention, so the
# collision is the normal case. The stub records the cwd it was called from;
# the assertion is that it is the push TARGET, not the session's own tree.
cross_repo_case() {
  local other target trace stub out rc
  other=$(mktemp -d); target=$(mktemp -d); trace=$(mktemp)
  git -C "$target" init -q .
  git -C "$target" remote add origin https://github.com/go-to-k/other.git
  stub=$(mktemp -d)/gh
  cat > "$stub" <<STUBEOF
#!/usr/bin/env bash
printf '%s\n' "\$PWD" >> "$trace"
# A MERGED PR exists only in the session's own tree, never in the target.
if [ "\$PWD" = "$other" ]; then
  echo '[{"number":2195,"mergedAt":"2026-08-25T10:13:25Z","headRefName":"chore/issue-dup-check","title":"x"}]'
else
  echo '[]'
fi
STUBEOF
  chmod +x "$stub"
  out=$(jq -n --arg c "git -C $target push origin chore/issue-dup-check" --arg d "$other" \
        '{tool_name:"Bash", tool_input:{command:$c}, cwd:$d}' \
        | GH_BIN="$stub" bash "$HOOK" 2>&1) && rc=0 || rc=$?
  if [ "$rc" -eq 0 ] && grep -qxF "$target" "$trace"; then
    echo "PASS: merged-PR lookup targets the push target, not the session repo"
    pass=$((pass + 1))
  else
    echo "FAIL: gate consulted the wrong repo (rc=$rc, gh cwd: $(tr '\n' ' ' < "$trace"))"
    fail=$((fail + 1))
  fi
  rm -rf "$other" "$target" "$trace"
}
cross_repo_case

# --- COMMAND POSITION (2026-08-31). The push args used to be extracted from the
# RAW command with `[[ "$cmd" =~ [[:space:]]push([[:space:]]+(.*))?$ ]]`, and a
# greedy trailing `(.*)$` makes the LEFTMOST ` push` win. Measured on that
# expression:
#
#   git push origin feat/x                             -> args=[origin feat/x]
#   echo "remember to push origin main" && git push ... -> args=[origin main" ]
#   git push origin main && git push origin feat/x     -> args=[origin main ]
#
# So a quoted MENTION steered the branch to `main"` and a two-push chain was
# judged on the first. Either way the merged-PR lookup asks about the wrong
# branch, finds nothing, and the orphan push proceeds unjudged.
#
# These need a HEAD-AWARE mock: the fixed-response mock above answers the same
# JSON whatever branch is asked about, so it cannot tell WHICH branch the gate
# judged -- the property every case here is about.
headaware_case() {
  local name="$1" want="$2" cmd="$3" want_heads="$4"
  local dir stub trace out rc heads
  dir="$TMPDIR/ha-repo"
  if [ ! -d "$dir" ]; then
    git init -q -b feat/already-merged "$dir"
    git -C "$dir" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
  fi
  trace="$TMPDIR/ha-trace.$$"
  : > "$trace"
  stub="$TMPDIR/gh-headaware.$$"
  cat > "$stub" <<EOF_STUB
#!/usr/bin/env bash
# Answers per --head, and RECORDS every head it was asked about, so a case can
# assert which branch the gate judged rather than only what it returned.
head=""
prev=""
for a in "\$@"; do
  [ "\$prev" = "--head" ] && head="\$a"
  prev="\$a"
done
printf '%s\n' "\$head" >> "$trace"
if [ "\$head" = "feat/already-merged" ]; then
  printf '%s\n' '[{"number":263,"mergedAt":"2026-05-11T03:00:00Z","headRefName":"feat/already-merged","title":"feat: cool stuff"}]'
else
  printf '%s\n' '[]'
fi
EOF_STUB
  chmod +x "$stub"
  out=$(jq -n --arg c "$cmd" --arg d "$dir" '{tool_name:"Bash",tool_input:{command:$c},cwd:$d}' \
        | GH_BIN="$stub" bash "$HOOK" 2>&1) && rc=0 || rc=$?
  heads=$(sort -u "$trace" | grep -v '^$' | tr '\n' ',' | sed 's/,$//')
  if [ "$rc" = "$want" ] && [ "$heads" = "$want_heads" ]; then
    pass=$((pass + 1))
    printf 'OK   %s (exit %s, heads asked: [%s])\n' "$name" "$rc" "$heads"
  else
    fail=$((fail + 1))
    fail_log+="FAIL $name: want exit $want heads [$want_heads], got exit $rc heads [$heads]\n"
    fail_log+="  command: $cmd\n  output : $out\n"
    printf 'FAIL %s (want exit %s heads [%s], got exit %s heads [%s])\n' "$name" "$want" "$want_heads" "$rc" "$heads"
  fi
  rm -f "$stub" "$trace"
}

# A quoted MENTION of a push must not steer the judgement. The exit code alone
# discriminates here because the mention names the SAFE branch and the real push
# names the merged one -- the reverse pairing yields 0 either way and would have
# fenced nothing.
headaware_case "a quoted mention of push does not steer the judgement" 2 \
  'echo "remember to push origin feat/not-merged" && git push origin feat/already-merged' \
  "feat/already-merged"

# TWO pushes chained. EVERY push is judged, so the merged one is caught wherever
# it sits; the old leftmost-wins extraction saw only the first.
headaware_case "a chained push is judged even when it is the SECOND" 2 \
  'git push origin feat/not-merged && git push origin feat/already-merged' \
  "feat/already-merged,feat/not-merged"
headaware_case "...and still when it is the first" 2 \
  'git push origin feat/already-merged && git push origin feat/not-merged' \
  "feat/already-merged"

# The `;` separator form, which the old stripping happened to handle -- a
# control that the move to segments did not lose it.
headaware_case "cd <dir>; git push <merged-branch> still blocks" 2 \
  "cd $TMPDIR/ha-repo; git push origin feat/already-merged" \
  "feat/already-merged"

# The pass direction, so the three blocking cases above are not satisfied by a
# hook that blocks any chained push.
headaware_case "a chain of pushes to non-merged branches passes" 0 \
  'git push origin feat/not-merged && git push origin feat/other-not-merged' \
  "feat/not-merged,feat/other-not-merged"

# The mandated quoted-body false-positive pair, in its CHAINED spelling. The
# heads trace must be EMPTY: the gate must not arm at all, which "exit 0" alone
# cannot tell from "armed and found nothing".
headaware_case "chained quoted mention alone never arms the gate" 0 \
  'git status && echo "do not run: git push origin feat/already-merged"' \
  ""

echo "Pass: $pass  Fail: $fail"
if [ "$fail" -gt 0 ]; then
  echo
  printf '%b' "$fail_log"
  exit 1
fi
