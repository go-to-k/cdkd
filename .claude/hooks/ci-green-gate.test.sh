#!/usr/bin/env bash
# Smoke test for ci-green-gate.sh.
#
# Exercises the live CI-status gate against a PATH-shimmed `gh`
# binary. Each case sets $GH_FIXTURE to control what `gh pr checks`
# returns (all-pass / fail / pending / skipping / no-checks / infra
# error), then asserts the hook's exit code matches the expected gate
# decision. Includes the standard quoted-body false-positive cases
# (cdkd#563) proving the matcher is line-start anchored.
#
# Run from the repo root: `bash .claude/hooks/ci-green-gate.test.sh`.

set -u

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/ci-green-gate.sh"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

SHIM_DIR="$(mktemp -d)"
cleanup() { rm -rf "$SHIM_DIR"; }
trap cleanup EXIT

pass=0
fail=0
fail_log=""

cat > "$SHIM_DIR/gh" <<'EOF_GH'
#!/usr/bin/env bash
set -u
case "${GH_FIXTURE:-}" in
  all-pass)
    printf 'check\tpass\t3s\thttps://x\n'
    printf 'check-build-test\tpass\t3m\thttps://x\n'
    exit 0 ;;
  with-skipping)
    printf 'check\tpass\t3s\thttps://x\n'
    printf 'runtime-compat\tskipping\t0\thttps://x\n'
    exit 1 ;;
  one-fail)
    printf 'check\tpass\t3s\thttps://x\n'
    printf 'check-build-test\tfail\t2m30s\thttps://x\n'
    exit 1 ;;
  pending)
    printf 'check-build-test\tpending\t0\thttps://x\n'
    exit 8 ;;
  no-checks)
    echo "no checks reported on the 'foo' branch" >&2
    exit 1 ;;
  infra-error)
    echo "error connecting to api.github.com" >&2
    exit 4 ;;
  *)
    echo "gh shim: unknown fixture '${GH_FIXTURE:-}'" >&2
    exit 99 ;;
esac
EOF_GH
chmod +x "$SHIM_DIR/gh"

run_case() {
  local name="$1" fixture="$2" command="$3" expected_rc="$4"
  local payload rc
  payload=$(printf '{"tool_input":{"command":%s},"cwd":"%s"}' \
    "$(printf '%s' "$command" | jq -Rs .)" "$REPO_ROOT")
  printf '%s' "$payload" | GH_FIXTURE="$fixture" PATH="$SHIM_DIR:$PATH" bash "$HOOK" >/dev/null 2>&1
  rc=$?
  if [ "$rc" -eq "$expected_rc" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    fail_log="$fail_log
  FAIL: $name (expected rc=$expected_rc, got rc=$rc)"
  fi
}

# Green paths — allow.
run_case "all checks pass" all-pass "gh pr merge 123 --squash --delete-branch" 0
run_case "skipping rows are green" with-skipping "gh pr merge 123 --squash" 0
run_case "cd-prefixed merge, all pass" all-pass "cd $REPO_ROOT && gh pr merge 123 --squash" 0

# Red / unsettled paths — block (exit 2).
run_case "one failing check blocks" one-fail "gh pr merge 123 --squash" 2
run_case "pending check blocks" pending "gh pr merge 123" 2
run_case "no checks reported blocks" no-checks "gh pr merge 123" 2
run_case "number-less merge with fail blocks" one-fail "gh pr merge --squash" 2

# Infra fail-open.
run_case "gh transport error fails open" infra-error "gh pr merge 123" 0

# Escape hatch.
run_case "CDKD_SKIP_CI_GREEN_GATE=1 bypasses" one-fail "CDKD_SKIP_CI_GREEN_GATE=1 gh pr merge 123 --squash" 0

# Non-merge commands pass through untouched (no gh call at all).
run_case "unrelated command passes" one-fail "git status" 0
run_case "gh pr create passes" one-fail "gh pr create --title x" 0

# Quoted-body false positives (cdkd#563): the trigger phrase inside an
# argument body must NOT fire the gate.
run_case "quoted body in issue create" one-fail "gh issue create --body \"remember to gh pr merge 123 later\"" 0
run_case "quoted body in echo" one-fail "echo \"next step: gh pr merge 123\"" 0

echo "ci-green-gate.test: $pass passed, $fail failed"
if [ "$fail" -gt 0 ]; then
  echo "$fail_log"
  exit 1
fi
exit 0
