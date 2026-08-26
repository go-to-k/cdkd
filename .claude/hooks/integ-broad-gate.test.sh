#!/usr/bin/env bash
# Smoke test for integ-broad-gate.sh.
#
# Exercises the command-matching (gh pr merge / gh pr create / git
# status / etc.) and the cross-cutting-files filter against a mocked
# `gh pr view --json files` response. Marker freshness is not asserted
# end-to-end (would require an actual `markgate set` against a fixture
# bucket); the hook's exit code suffices to verify the gate's filter
# logic decides whether to consult markgate at all.
#
# Run from the repo root: `bash .claude/hooks/integ-broad-gate.test.sh`.

set -u

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/integ-broad-gate.sh"

# go-to-k/cdkd#2236: a fixture repo must DECLARE the gate the hook asks about,
# the way the real repo does. The gates now read the target repo's own
# `.markgate.yml` to tell "this repo does not have that gate" (unsatisfiable --
# the sibling-repo defect) from "the marker is stale", so a fixture with no
# config takes the no-equivalent-gate refusal and never reaches markgate at all.
# Without this the cwd assertions below go green-to-red, and worse, the exit-2
# cases would pass for the wrong reason.
declare_gate() {
  printf 'gates:\n  %s:\n    hash: files\n    include:\n      - "src/**"\n' "$2" > "$1/.markgate.yml"
}


TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

# Mock `gh` binary: each test case writes the JSON it wants to a
# file the mock reads on stdout. Path injected via $GH_BIN env var
# so the hook's `command -v gh` and direct `gh pr view` invocations
# both pick up the mock.
GH_BIN_DIR="$TMPDIR/bin"
mkdir -p "$GH_BIN_DIR"
GH_MOCK_PAYLOAD="$TMPDIR/gh-mock-payload.json"
cat > "$GH_BIN_DIR/gh" <<EOF
#!/usr/bin/env bash
# Mock gh: serve the JSON in \$GH_MOCK_PAYLOAD verbatim. Used by
# integ-broad-gate.sh's PR-files lookup. Exit 1 if no payload file
# exists (simulates 'gh' failure for the infra-fail-open test).
if [ ! -f "$GH_MOCK_PAYLOAD" ]; then
  exit 1
fi
cat "$GH_MOCK_PAYLOAD"
EOF
chmod +x "$GH_BIN_DIR/gh"

# Mock `mise` and `markgate`: isolates the test from the local
# repo's markgate state. Pre-PR (the design comment at the original
# L93-98 noted "marker is currently no-marker on this branch") the
# test relied on the user not having flipped `integ-broad` fresh —
# but on a working checkout immediately after a successful
# /run-integ bench-cdk-sample, the marker IS fresh and every "block"
# case above silently returned exit 0 instead of 2. The mock here
# pins markgate's verdict to whatever $MARKGATE_MOCK_VERDICT says
# (default "stale" — what the block cases assume), so the test runs
# the same on a fresh clone, in CI, and on a developer's checkout
# with an arbitrary local marker state.
#
# The hook's `command -v mise` check picks up THIS mock first; the
# pass-through form (`mise exec -- markgate <args>`) then routes to
# the mocked `markgate` below — same code path the hook hits in
# production when `mise` is installed.
cat > "$GH_BIN_DIR/mise" <<'MISE_EOF'
#!/usr/bin/env bash
# Mock mise: pass-through for `mise exec -- <cmd> <args>`. Any other
# subcommand exits 1 (the hook only uses `mise exec --`).
if [ "$1" = "exec" ] && [ "$2" = "--" ]; then
  shift 2
  exec "$@"
fi
exit 1
MISE_EOF
chmod +x "$GH_BIN_DIR/mise"

# Trace file: the mocked markgate writes $PWD to this file on every
# call. Each test case can assert the hook `cd`'d to the resolved
# target dir before invoking markgate. Mirrors check-gate.test.sh
# (post-#562) — closes the coverage gap the #562 reviewer flagged
# (only 4 of 7 cwd-aware test files asserted via $CWD_TRACE_FILE;
# this is one of the 3 that didn't).
CWD_TRACE_FILE="$TMPDIR/cwd-trace"

cat > "$GH_BIN_DIR/markgate" <<MARKGATE_EOF
#!/usr/bin/env bash
# Mock markgate: verdict pinned by \$MARKGATE_MOCK_VERDICT
# ("fresh" -> verify exits 0; anything else -> verify exits 1 and
# status prints a parseable stale line). The hook's awk extractor
# pulls "(reason)" out of \`state:\` for the error message.
# Also writes \$PWD to \$CWD_TRACE_FILE so the cwd-aware test cases
# can assert the hook \`cd\`'d to the resolved target dir.
echo "\$PWD" >> "$CWD_TRACE_FILE"
verdict="\${MARKGATE_MOCK_VERDICT:-stale}"
case "\$1" in
  verify)
    [ "\$verdict" = "fresh" ] && exit 0
    exit 1
    ;;
  status)
    if [ "\$verdict" = "fresh" ]; then
      printf 'key:        %s\nstate:      match\n' "\$2"
    else
      printf 'key:        %s\nstate:      stale (marker missing)\n' "\$2"
    fi
    exit 0
    ;;
esac
exit 1
MARKGATE_EOF
chmod +x "$GH_BIN_DIR/markgate"

export PATH="$GH_BIN_DIR:$PATH"
export MARKGATE_MOCK_VERDICT="stale"

pass=0
fail=0
fail_log=""

# run_case <name> <expect_exit> <payload> <gh_files_json> [expect_cwd]
#   payload         — PreToolUse JSON the hook reads from stdin
#   gh_files_json   — JSON to return from mocked `gh pr view --json files`
#                     (use empty string to simulate gh failure)
#   expect_cwd      — optional: the directory the hook should have
#                     cd'd into before calling markgate. When set, the
#                     mocked markgate appends $PWD to $CWD_TRACE_FILE
#                     and we assert it contains expect_cwd. Empty
#                     skips the cwd assertion (used for pass-through
#                     cases that never reach markgate).
run_case() {
  local name="$1"; local want="$2"; local payload="$3"; local gh_files="$4"; local expect_cwd="${5:-}"
  : > "$CWD_TRACE_FILE"
  if [ -n "$gh_files" ]; then
    echo "$gh_files" > "$GH_MOCK_PAYLOAD"
  else
    rm -f "$GH_MOCK_PAYLOAD"
  fi
  local got
  printf '%s' "$payload" | "$HOOK" >/dev/null 2>&1
  got=$?

  local cwd_ok=1
  if [ -n "$expect_cwd" ]; then
    if ! grep -qFx "$expect_cwd" "$CWD_TRACE_FILE" 2>/dev/null; then
      cwd_ok=0
    fi
  fi

  if [[ "$got" == "$want" ]] && [ "$cwd_ok" -eq 1 ]; then
    pass=$((pass + 1))
    printf 'OK   %s (exit %s)\n' "$name" "$got"
  else
    fail=$((fail + 1))
    fail_log+="FAIL $name: want exit $want, got $got"
    if [ "$cwd_ok" -eq 0 ]; then
      fail_log+="; cwd mismatch (want '$expect_cwd', trace: $(cat "$CWD_TRACE_FILE" 2>/dev/null | tr '\n' '|'))"
    fi
    fail_log+="\n  payload: $payload\n"
    printf 'FAIL %s (want %s, got %s)\n' "$name" "$want" "$got"
  fi
}

# --- Pass-through cases (hook should exit 0 immediately) -------------

run_case "pass: gh pr create (not gated)" 0 \
  '{"tool_input":{"command":"gh pr create --title x --body y"},"cwd":"."}' ""

run_case "pass: gh pr view (not gated)" 0 \
  '{"tool_input":{"command":"gh pr view 123"},"cwd":"."}' ""

run_case "pass: git status (not gated)" 0 \
  '{"tool_input":{"command":"git status"},"cwd":"."}' ""

run_case "pass: empty command" 0 \
  '{"tool_input":{"command":""},"cwd":"."}' ""

# --- gh pr merge with no cross-cutting files (gate passes through) ----

run_case "pass: gh pr merge with only docs/test changes" 0 \
  '{"tool_input":{"command":"gh pr merge 100 --squash"},"cwd":"."}' \
  '{"files":[{"path":"README.md"},{"path":"tests/unit/foo.test.ts"}]}'

run_case "pass: gh pr merge with only fixture changes" 0 \
  '{"tool_input":{"command":"gh pr merge --auto 200"},"cwd":"."}' \
  '{"files":[{"path":"tests/integration/basic/lib/basic-stack.ts"}]}'

# --- gh pr merge WITH cross-cutting files: hook proceeds to markgate
#     verify. Marker is currently no-marker on this branch, so we
#     expect exit 2 (block). If the user has set the marker fresh
#     (e.g. immediately after a /run-integ bench-cdk-sample run),
#     this case would pass — but in CI / fresh-clone topology, no
#     marker is the default. ---

run_case "block: gh pr merge touches deploy-engine.ts" 2 \
  '{"tool_input":{"command":"gh pr merge 300 --squash"},"cwd":"."}' \
  '{"files":[{"path":"src/deployment/deploy-engine.ts"}]}'

run_case "block: gh pr merge touches destroy-runner.ts" 2 \
  '{"tool_input":{"command":"gh pr merge 400 --auto --delete-branch"},"cwd":"."}' \
  '{"files":[{"path":"src/cli/commands/destroy-runner.ts"}]}'

run_case "block: gh pr merge touches dag-builder.ts" 2 \
  '{"tool_input":{"command":"gh pr merge 500"},"cwd":"."}' \
  '{"files":[{"path":"src/analyzer/dag-builder.ts"}]}'

run_case "block: gh pr merge touches intrinsic-function-resolver.ts" 2 \
  '{"tool_input":{"command":"gh pr merge 600 --squash --auto"},"cwd":"."}' \
  '{"files":[{"path":"src/deployment/intrinsic-function-resolver.ts"}]}'

# --- Issue #2042: the retry classifier + the rollback executor.
#
# These three files sat in NO integ gate's scope while `withRetry` wrapped
# every provider's create/update/delete and `rollback-executor.ts` deleted and
# re-created real resources on the reverse-replacement path. Each is asserted
# ALONE (not folded into a mixed-file case) so that dropping any ONE
# alternative from CROSS_CUTTING_REGEX fails a case — a mixed payload would
# stay green on the surviving members and report a working gate for a scope
# that had silently shrunk.
#
# Verified by construction against the pre-change hook (`git show
# HEAD:.claude/hooks/integ-broad-gate.sh`): all three cases exit 0 there,
# i.e. they FAIL, which is what makes them evidence rather than decoration.

run_case "block: gh pr merge touches retryable-errors.ts (#2042)" 2 \
  '{"tool_input":{"command":"gh pr merge 310 --squash"},"cwd":"."}' \
  '{"files":[{"path":"src/deployment/retryable-errors.ts"}]}'

run_case "block: gh pr merge touches retry.ts (#2042)" 2 \
  '{"tool_input":{"command":"gh pr merge 320 --squash"},"cwd":"."}' \
  '{"files":[{"path":"src/deployment/retry.ts"}]}'

run_case "block: gh pr merge touches rollback-executor.ts (#2042)" 2 \
  '{"tool_input":{"command":"gh pr merge 330 --squash"},"cwd":"."}' \
  '{"files":[{"path":"src/deployment/rollback-executor.ts"}]}'

# Near-miss control for the widened alternation. `retry|retryable-errors`
# must stay anchored at both ends: a sibling whose basename merely STARTS
# with `retry` is not in scope, and neither is the unit test for one of the
# scoped files. Without these, replacing the alternation with a loose
# `retry.*` would pass every case above while quietly gating unrelated files.
run_case "pass: gh pr merge touches retry-helpers.ts (not in scope)" 0 \
  '{"tool_input":{"command":"gh pr merge 340 --squash"},"cwd":"."}' \
  '{"files":[{"path":"src/deployment/retry-helpers.ts"}]}'

run_case "pass: gh pr merge touches the retry UNIT TEST only" 0 \
  '{"tool_input":{"command":"gh pr merge 350 --squash"},"cwd":"."}' \
  '{"files":[{"path":"tests/unit/deployment/retry-transient-server-error.test.ts"}]}'

run_case "block: mix of cross-cutting + unrelated" 2 \
  '{"tool_input":{"command":"gh pr merge 700"},"cwd":"."}' \
  '{"files":[{"path":"README.md"},{"path":"src/deployment/deploy-engine.ts"},{"path":"docs/foo.md"}]}'

# --- gh pr merge with no PR number (gh resolves current branch) ----

run_case "block: gh pr merge no-number, current branch touches cross-cutting" 2 \
  '{"tool_input":{"command":"gh pr merge --squash"},"cwd":"."}' \
  '{"files":[{"path":"src/cli/commands/deploy.ts"}]}'

# --- Infra fail-open: gh pr view fails (e.g. auth missing, offline). ---

run_case "pass: gh failure during PR files lookup (fail-open)" 0 \
  '{"tool_input":{"command":"gh pr merge 800"},"cwd":"."}' ""

# --- Fresh marker path: cross-cutting diff + fresh integ-broad marker -> pass ---
# Mirrors the just-after-/run-integ-bench-cdk-sample state. Pre-this-PR
# the test never exercised this branch (marker was assumed missing on
# CI / fresh clones); the mock above lets us pin it explicitly.
MARKGATE_MOCK_VERDICT="fresh" run_case "pass: cross-cutting diff + fresh integ-broad marker" 0 \
  '{"tool_input":{"command":"gh pr merge 900 --squash"},"cwd":"."}' \
  '{"files":[{"path":"src/deployment/deploy-engine.ts"}]}'

# --- CWD-AWARE cases (cdkd #559) ---
#
# These cases verify that the hook resolves the target git working
# tree from the PreToolUse payload's `cwd` field and from
# `cd <path>` / `gh -C <path>` in the command. Pre-#559 the hook
# always landed in the main tree.
#
# The cwd-resolution helpers need a real git repo at the target dir
# to pass `git -C <path> rev-parse --git-dir` (the silent-pass
# guard). Create two fixture repos for that.

CWD_SIDE_REPO="$TMPDIR/side-worktree"
CWD_MAIN_REPO="$TMPDIR/main-worktree"
git init -q -b feature/x "$CWD_SIDE_REPO"
declare_gate "$CWD_SIDE_REPO" integ-broad
git -C "$CWD_SIDE_REPO" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
git init -q -b main "$CWD_MAIN_REPO"
declare_gate "$CWD_MAIN_REPO" integ-broad
git -C "$CWD_MAIN_REPO" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init

# cd-from-payload `cwd` field routes the hook to the side worktree;
# cross-cutting PR + stale marker → block. The block proves the hook
# reached markgate from the resolved worktree, not from a hardcoded
# main-tree resolution. $CWD_TRACE_FILE assertion verifies the hook
# actually `cd`'d into the resolved target dir before invoking
# markgate (issue #563 — closes the coverage gap the PR #562
# reviewer flagged).
run_case "block: side worktree cwd + cross-cutting diff" 2 \
  "$(printf '{"tool_input":{"command":"gh pr merge 1000 --squash"},"cwd":"%s"}' "$CWD_SIDE_REPO")" \
  '{"files":[{"path":"src/deployment/deploy-engine.ts"}]}' \
  "$CWD_SIDE_REPO"

# `cd <side> && gh pr merge` from main cwd: cd target wins, hook
# operates in side worktree.
run_case "block: cd <side> && gh pr merge from main cwd" 2 \
  "$(printf '{"tool_input":{"command":"cd %s && gh pr merge 1001 --squash"},"cwd":"%s"}' "$CWD_SIDE_REPO" "$CWD_MAIN_REPO")" \
  '{"files":[{"path":"src/deployment/deploy-engine.ts"}]}' \
  "$CWD_SIDE_REPO"

# `gh -C <side> pr merge` from main cwd: -C target wins.
run_case "block: gh -C <side> pr merge from main cwd" 2 \
  "$(printf '{"tool_input":{"command":"gh -C %s pr merge 1002 --squash"},"cwd":"%s"}' "$CWD_SIDE_REPO" "$CWD_MAIN_REPO")" \
  '{"files":[{"path":"src/deployment/deploy-engine.ts"}]}' \
  "$CWD_SIDE_REPO"

# --- LINE-START ANCHORING cases (issue #563) ---
#
# The matcher MUST NOT fire when the literal substring `gh pr merge`
# appears inside a quoted argument body of an unrelated command. Per
# memory rule feedback_hook_command_match_line_start.md, applied to
# integ-broad-gate.sh in issue #563 (mirroring the PR #562 fix to
# check-gate.sh). Even with a cross-cutting PR diff, the quoted-body
# form must pass through because the matcher fires BEFORE the diff
# scope check.

run_case "pass: gh issue body quoting 'gh pr merge' (FP)" 0 \
  '{"tool_input":{"command":"gh issue create --body \"next step: gh pr merge --squash\""},"cwd":"."}' \
  '{"files":[{"path":"src/deployment/deploy-engine.ts"}]}'

run_case "pass: echo body quoting 'gh pr merge' (FP)" 0 \
  '{"tool_input":{"command":"echo \"after CI: gh pr merge 999 --auto\""},"cwd":"."}' \
  '{"files":[{"path":"src/deployment/deploy-engine.ts"}]}'


# --- CROSS-REPO GATE NAMING (go-to-k/cdkd#2236) ---
#
# This hook fires on every Bash call the session makes, including merges whose
# target is a SIBLING repository -- deliberate policy. It then asked that repo
# about `integ-broad`, a cdkd-only gate name, and markgate exits 1 for an
# UNDECLARED gate exactly as it does for a stale marker (measured with markgate
# 0.4.1: `status` prints `state: no marker` in both cases). The refusal was
# therefore unsatisfiable by any legitimate action -- hit live on
# `integ-local-gate`, and structurally identical here.
#
# Case 2 is the load-bearing one for THIS gate: unlike `integ-local` there is
# deliberately NO alias row for `integ-broad`, because neither sibling verifies
# anything equivalent. It drives a FRESH verdict, so a hook that had guessed an
# alias by name would exit 0 and the case would fail.
x2236_mk_repo() {
  local dir="$1" origin="$2"; shift 2
  git init -q -b feature/x "$dir"
  git -C "$dir" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
  [ "$origin" = "-" ] || git -C "$dir" remote add origin "$origin"
  if [ "$#" -gt 0 ]; then
    printf 'gates:\n' > "$dir/.markgate.yml"
    local g
    for g in "$@"; do
      printf '  %s:\n    hash: files\n    include:\n      - "src/**"\n' "$g" >> "$dir/.markgate.yml"
    done
  fi
}

x2236_declares="$TMPDIR/x2236-declares"
x2236_mk_repo "$x2236_declares" "https://github.com/go-to-k/cdkd.git" check integ-broad
x2236_other="$TMPDIR/x2236-other"
x2236_mk_repo "$x2236_other" "https://github.com/go-to-k/cdk-local.git" check docs integ
x2236_bare="$TMPDIR/x2236-bare"
x2236_mk_repo "$x2236_bare" "https://github.com/go-to-k/cdk-local.git"
x2236_emptycfg="$TMPDIR/x2236-emptycfg"
x2236_mk_repo "$x2236_emptycfg" "https://github.com/go-to-k/cdk-local.git" check
: > "$x2236_emptycfg/.markgate.yml"

# x2236_case <name> <want_exit> <verdict> <CALLED|NOT_CALLED> <want-stderr|-> <repo>
#   The marker expectation reads $CWD_TRACE_FILE, which the mocked markgate
#   appends to on every call: an empty trace means the gate answered without
#   consulting a marker at all, which is what the no-equivalent refusal must do.
x2236_case() {
  local name="$1" want="$2" verdict="$3" mg="$4" want_txt="$5" repo="$6"
  local out got detail=""
  : > "$CWD_TRACE_FILE"
  printf '{"files":[{"path":"src/deployment/deploy-engine.ts"}]}' > "$GH_MOCK_PAYLOAD"
  out=$(printf '{"cwd":"%s","tool_input":{"command":"gh pr merge 1 --squash"}}' "$repo" \
    | MARKGATE_MOCK_VERDICT="$verdict" "$HOOK" 2>&1)
  got=$?
  [ "$got" = "$want" ] || detail="$detail; want exit $want, got $got"
  if [ "$mg" = "NOT_CALLED" ] && [ -s "$CWD_TRACE_FILE" ]; then
    detail="$detail; markgate must not be consulted, trace: $(tr '\n' '|' < "$CWD_TRACE_FILE")"
  fi
  if [ "$mg" = "CALLED" ] && [ ! -s "$CWD_TRACE_FILE" ]; then
    detail="$detail; markgate was never consulted"
  fi
  if [ "$want_txt" != "-" ] && ! printf '%s' "$out" | grep -qF "$want_txt"; then
    detail="$detail; stderr missing [$want_txt]"
  fi
  if [ -z "$detail" ]; then
    pass=$((pass + 1)); printf 'OK   %s (exit %s)\n' "$name" "$got"
  else
    fail=$((fail + 1))
    fail_log="${fail_log}FAIL $name$detail\n  output: $out\n"
    printf 'FAIL %s%s\n' "$name" "$detail"
  fi
}

x2236_case "target declaring integ-broad consults that marker" 2 stale CALLED - "$x2236_declares"
x2236_case "sibling declaring only its own gate is NOT accepted on it" 2 fresh NOT_CALLED "declares no gate" "$x2236_other"
x2236_case "checkout with no .markgate.yml refuses actionably" 2 fresh NOT_CALLED "GATE_MARKER_ALIASES" "$x2236_bare"
x2236_case "unparsable config keeps the cdkd gate name (fail closed)" 2 stale CALLED "integ-broad" "$x2236_emptycfg"

# ---- Summary ----

echo ""
printf '%d pass, %d fail\n' "$pass" "$fail"
if [ "$fail" -gt 0 ]; then
  printf '%b' "$fail_log"
  exit 1
fi
exit 0
