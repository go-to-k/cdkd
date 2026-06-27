#!/usr/bin/env bash
# Smoke test for ref-segment-audit-gate.sh.
#
# Each case spins up a throwaway git repo, commits a baseline
# intrinsic-function-resolver.ts (+ optional baseline unit test), stages a
# diff adding entries to REF_RETURNS_SEGMENT_AFTER_PIPE (+ optional unit-test
# coverage), and runs the hook against a synthetic git-commit invocation.
# Exit 0 = allow, exit 2 = block.
#
# Run from the repo root:
#   bash .claude/hooks/ref-segment-audit-gate.test.sh

set -u

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/ref-segment-audit-gate.sh"
RESOLVER="src/deployment/intrinsic-function-resolver.ts"
TESTDIR_REL="tests/unit/deployment"

pass=0
fail=0
fail_log=""

baseline_resolver() {
  cat <<'TS'
const REF_RETURNS_SEGMENT_AFTER_PIPE = new Set<string>([
  'AWS::ApiGateway::Model',
  'AWS::Cognito::UserPoolClient',
]);
export { REF_RETURNS_SEGMENT_AFTER_PIPE };
TS
}

# write_resolver_with <extra-entries...> — re-emit the Set with extra lines.
write_resolver_with() {
  local dir="$1"; shift
  {
    echo 'const REF_RETURNS_SEGMENT_AFTER_PIPE = new Set<string>(['
    echo "  'AWS::ApiGateway::Model',"
    echo "  'AWS::Cognito::UserPoolClient',"
    local e
    for e in "$@"; do
      echo "  '$e',"
    done
    echo ']);'
    echo 'export { REF_RETURNS_SEGMENT_AFTER_PIPE };'
  } > "$dir/$RESOLVER"
}

# run_case <name> <want_exit> <setup_fn>
run_case() {
  local name="$1"; local want="$2"; local setup_fn="$3"

  local tmpdir
  tmpdir=$(mktemp -d)
  trap "rm -rf '$tmpdir'" RETURN

  ( cd "$tmpdir" && git init -q && git config user.email t@t && git config user.name t ) >/dev/null 2>&1
  mkdir -p "$tmpdir/$(dirname "$RESOLVER")" "$tmpdir/$TESTDIR_REL"

  # Baseline commit: resolver + a baseline test that already covers the
  # two seed types.
  baseline_resolver > "$tmpdir/$RESOLVER"
  cat > "$tmpdir/$TESTDIR_REL/intrinsic-functions.test.ts" <<'TS'
// baseline coverage
it('AWS::ApiGateway::Model ref', () => {});
it('AWS::Cognito::UserPoolClient ref', () => {});
TS
  ( cd "$tmpdir" && git add -A && git commit -qm baseline ) >/dev/null 2>&1

  # Per-case mutation.
  "$setup_fn" "$tmpdir"

  local cmdstr
  cmdstr=$(printf 'git -C %q commit -m "feat: add ref segment type"' "$tmpdir")
  local payload
  payload=$(jq -cn --arg c "$cmdstr" '{tool_input:{command:$c}}')

  local got
  printf '%s' "$payload" | "$HOOK" >/dev/null 2>&1
  got=$?

  if [[ "$got" == "$want" ]]; then
    pass=$((pass + 1)); printf 'OK   %s (exit %s)\n' "$name" "$got"
  else
    fail=$((fail + 1))
    fail_log+="FAIL $name: want $want got $got\n"
    printf 'FAIL %s (want %s, got %s)\n' "$name" "$want" "$got"
  fi
}

# --- BLOCK: add a type with no unit-test coverage ---
setup_add_uncovered() {
  local d="$1"
  write_resolver_with "$d" 'AWS::Cognito::UserPoolGroup'
  ( cd "$d" && git add "$RESOLVER" ) >/dev/null 2>&1
}
run_case "add type, no test -> block" 2 setup_add_uncovered

# --- ALLOW: add a type WITH a staged unit test referencing it ---
setup_add_covered_staged() {
  local d="$1"
  write_resolver_with "$d" 'AWS::Cognito::UserPoolGroup'
  cat >> "$d/$TESTDIR_REL/intrinsic-functions.test.ts" <<'TS'
it('AWS::Cognito::UserPoolGroup ref returns trailing segment', () => {});
TS
  ( cd "$d" && git add -A ) >/dev/null 2>&1
}
run_case "add type + staged test -> allow" 0 setup_add_covered_staged

# --- ALLOW: add a type already referenced by a tracked (committed) test ---
setup_add_covered_tracked() {
  local d="$1"
  # Pre-existing tracked test that references the type (separate file).
  cat > "$d/$TESTDIR_REL/family.test.ts" <<'TS'
it('AWS::Cognito::UserPoolGroup family', () => {});
TS
  ( cd "$d" && git add -A && git commit -qm "add tracked test" ) >/dev/null 2>&1
  write_resolver_with "$d" 'AWS::Cognito::UserPoolGroup'
  ( cd "$d" && git add "$RESOLVER" ) >/dev/null 2>&1
}
run_case "add type + tracked test -> allow" 0 setup_add_covered_tracked

# --- ALLOW: refactor no-op (remove + re-add same set) ---
setup_refactor_noop() {
  local d="$1"
  # Re-write identical content (touch only) — no net-new entry.
  write_resolver_with "$d"
  ( cd "$d" && git add "$RESOLVER" ) >/dev/null 2>&1
}
run_case "no net-new entry -> allow" 0 setup_refactor_noop

# --- ALLOW: resolver not staged at all ---
setup_no_resolver_change() {
  local d="$1"
  echo "// unrelated" >> "$d/$TESTDIR_REL/intrinsic-functions.test.ts"
  ( cd "$d" && git add -A ) >/dev/null 2>&1
}
run_case "resolver untouched -> allow" 0 setup_no_resolver_change

# --- BLOCK: two added, only one covered ---
setup_two_one_covered() {
  local d="$1"
  write_resolver_with "$d" 'AWS::Cognito::UserPoolGroup' 'AWS::Cognito::UserPoolDomain'
  cat >> "$d/$TESTDIR_REL/intrinsic-functions.test.ts" <<'TS'
it('AWS::Cognito::UserPoolGroup ref', () => {});
TS
  ( cd "$d" && git add -A ) >/dev/null 2>&1
}
run_case "two added one uncovered -> block" 2 setup_two_one_covered

# --- ALLOW: non-commit command passes through ---
{
  payload=$(jq -cn --arg c 'git status' '{tool_input:{command:$c}}')
  printf '%s' "$payload" | "$HOOK" >/dev/null 2>&1
  got=$?
  if [[ "$got" == 0 ]]; then pass=$((pass+1)); printf 'OK   non-commit passes (exit 0)\n'
  else fail=$((fail+1)); fail_log+="FAIL non-commit: want 0 got $got\n"; printf 'FAIL non-commit (got %s)\n' "$got"; fi
}

# --- ALLOW: quoted-body false-positive (git commit keyword inside echo arg) ---
{
  payload=$(jq -cn --arg c "echo 'remember to git commit after adding AWS::Cognito::UserPoolGroup'" '{tool_input:{command:$c}}')
  printf '%s' "$payload" | "$HOOK" >/dev/null 2>&1
  got=$?
  if [[ "$got" == 0 ]]; then pass=$((pass+1)); printf 'OK   quoted-body echo passes (exit 0)\n'
  else fail=$((fail+1)); fail_log+="FAIL quoted-body: want 0 got $got\n"; printf 'FAIL quoted-body (got %s)\n' "$got"; fi
}

echo ""
echo "ref-segment-audit-gate.test.sh: $pass passed, $fail failed"
if [[ "$fail" -gt 0 ]]; then printf '%b' "$fail_log"; exit 1; fi
