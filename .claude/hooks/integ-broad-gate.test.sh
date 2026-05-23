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

cat > "$GH_BIN_DIR/markgate" <<'MARKGATE_EOF'
#!/usr/bin/env bash
# Mock markgate: verdict pinned by $MARKGATE_MOCK_VERDICT
# ("fresh" -> verify exits 0; anything else -> verify exits 1 and
# status prints a parseable stale line). The hook's awk extractor
# pulls "(reason)" out of `state:` for the error message.
verdict="${MARKGATE_MOCK_VERDICT:-stale}"
case "$1" in
  verify)
    [ "$verdict" = "fresh" ] && exit 0
    exit 1
    ;;
  status)
    if [ "$verdict" = "fresh" ]; then
      printf 'key:        %s\nstate:      match\n' "$2"
    else
      printf 'key:        %s\nstate:      stale (marker missing)\n' "$2"
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

# run_case <name> <expect_exit> <payload> <gh_files_json>
#   payload         — PreToolUse JSON the hook reads from stdin
#   gh_files_json   — JSON to return from mocked `gh pr view --json files`
#                     (use empty string to simulate gh failure)
run_case() {
  local name="$1"; local want="$2"; local payload="$3"; local gh_files="$4"
  if [ -n "$gh_files" ]; then
    echo "$gh_files" > "$GH_MOCK_PAYLOAD"
  else
    rm -f "$GH_MOCK_PAYLOAD"
  fi
  local got
  printf '%s' "$payload" | "$HOOK" >/dev/null 2>&1
  got=$?
  if [[ "$got" == "$want" ]]; then
    pass=$((pass + 1))
    printf 'OK   %s (exit %s)\n' "$name" "$got"
  else
    fail=$((fail + 1))
    fail_log+="FAIL $name: want exit $want, got $got\n"
    fail_log+="  payload: $payload\n"
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
git -C "$CWD_SIDE_REPO" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
git init -q -b main "$CWD_MAIN_REPO"
git -C "$CWD_MAIN_REPO" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init

# cd-from-payload `cwd` field routes the hook to the side worktree;
# cross-cutting PR + stale marker → block. The block proves the hook
# reached markgate from the resolved worktree, not from a hardcoded
# main-tree resolution.
run_case "block: side worktree cwd + cross-cutting diff" 2 \
  "$(printf '{"tool_input":{"command":"gh pr merge 1000 --squash"},"cwd":"%s"}' "$CWD_SIDE_REPO")" \
  '{"files":[{"path":"src/deployment/deploy-engine.ts"}]}'

# `cd <side> && gh pr merge` from main cwd: cd target wins, hook
# operates in side worktree.
run_case "block: cd <side> && gh pr merge from main cwd" 2 \
  "$(printf '{"tool_input":{"command":"cd %s && gh pr merge 1001 --squash"},"cwd":"%s"}' "$CWD_SIDE_REPO" "$CWD_MAIN_REPO")" \
  '{"files":[{"path":"src/deployment/deploy-engine.ts"}]}'

# `gh -C <side> pr merge` from main cwd: -C target wins.
run_case "block: gh -C <side> pr merge from main cwd" 2 \
  "$(printf '{"tool_input":{"command":"gh -C %s pr merge 1002 --squash"},"cwd":"%s"}' "$CWD_SIDE_REPO" "$CWD_MAIN_REPO")" \
  '{"files":[{"path":"src/deployment/deploy-engine.ts"}]}'

# ---- Summary ----

echo ""
printf '%d pass, %d fail\n' "$pass" "$fail"
if [ "$fail" -gt 0 ]; then
  printf '%b' "$fail_log"
  exit 1
fi
exit 0
