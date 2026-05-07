#!/usr/bin/env bash
# Smoke test for roundtrip-test-gate.sh.
#
# Builds fixture git repos with a structure that mimics cdkd's
# (src/provisioning/providers/, tests/unit/provisioning/), stages
# different combinations of provider + test, and asserts the hook's
# exit code. Run from the repo root:
#   bash .claude/hooks/roundtrip-test-gate.test.sh

set -u

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/roundtrip-test-gate.sh"

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

# init_repo <dir>
# Initialize a fresh git repo with an empty initial commit and the
# directory layout the hook expects.
init_repo() {
  local dir="$1"
  git init -q -b main "$dir"
  git -C "$dir" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
  mkdir -p "$dir/src/provisioning/providers"
  mkdir -p "$dir/tests/unit/provisioning"
}

# write_provider <dir> <name> <with_readcurrent>
# `<with_readcurrent>` is "yes" or "no" — controls whether the file
# contains readCurrentState.
write_provider() {
  local dir="$1" name="$2" with_rc="$3"
  local f="$dir/src/provisioning/providers/${name}.ts"
  if [[ "$with_rc" == "yes" ]]; then
    cat > "$f" <<'EOF'
export class FakeProvider {
  async readCurrentState(): Promise<unknown> { return {}; }
  async create() { return { physicalId: 'x', attributes: {} }; }
  async update() { /* noop */ }
  async delete() { /* noop */ }
  async getAttribute() { return undefined; }
}
EOF
  else
    cat > "$f" <<'EOF'
export class FakeSubResourceProvider {
  async create() { return { physicalId: 'x', attributes: {} }; }
  async update() { /* noop */ }
  async delete() { /* noop */ }
  async getAttribute() { return undefined; }
}
EOF
  fi
}

# write_test <dir> <relpath>
write_test() {
  local dir="$1" rel="$2"
  local f="$dir/$rel"
  mkdir -p "$(dirname "$f")"
  cat > "$f" <<'EOF'
import { describe, it, expect } from 'vitest';
describe('roundtrip', () => { it('placeholder', () => { expect(true).toBe(true); }); });
EOF
}

pass=0
fail=0
fail_log=""

# run_case <name> <expect_exit> <stdin_json>
run_case() {
  local name="$1"; local want="$2"; local payload="$3"
  local got out
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
    printf 'FAIL %s (want %s, got %s)\n' "$name" "$want" "$got"
  fi
}

# --- Fixture 1: new provider WITH readCurrentState + matching round-trip test ---
# Expected: pass (exit 0).
repo1="$TMPDIR/fixture1"
init_repo "$repo1"
write_provider "$repo1" "fake-foo-provider" yes
write_test "$repo1" "tests/unit/provisioning/fake-foo-provider-roundtrip.test.ts"
git -C "$repo1" add src/provisioning/providers/fake-foo-provider.ts \
                  tests/unit/provisioning/fake-foo-provider-roundtrip.test.ts
run_case "new provider + matching roundtrip test allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m feat"}}' "$repo1")"

# --- Fixture 1b: -update.test.ts naming variant also accepted ---
repo1b="$TMPDIR/fixture1b"
init_repo "$repo1b"
write_provider "$repo1b" "fake-bar-provider" yes
write_test "$repo1b" "tests/unit/provisioning/fake-bar-provider-update.test.ts"
git -C "$repo1b" add src/provisioning/providers/fake-bar-provider.ts \
                  tests/unit/provisioning/fake-bar-provider-update.test.ts
run_case "new provider + -update.test.ts variant allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m feat"}}' "$repo1b")"

# --- Fixture 2: new provider WITH readCurrentState + NO test → fail ---
repo2="$TMPDIR/fixture2"
init_repo "$repo2"
write_provider "$repo2" "fake-baz-provider" yes
git -C "$repo2" add src/provisioning/providers/fake-baz-provider.ts
run_case "new provider with readCurrentState + missing test blocked" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m feat"}}' "$repo2")"

# --- Fixture 3: new provider WITHOUT readCurrentState (sub-resource) → pass ---
repo3="$TMPDIR/fixture3"
init_repo "$repo3"
write_provider "$repo3" "fake-sub-provider" no
git -C "$repo3" add src/provisioning/providers/fake-sub-provider.ts
run_case "new sub-resource provider without readCurrentState allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m feat"}}' "$repo3")"

# --- Fixture 4: edit existing provider (status M, not A) → pass ---
repo4="$TMPDIR/fixture4"
init_repo "$repo4"
write_provider "$repo4" "fake-existing-provider" yes
git -C "$repo4" add src/provisioning/providers/fake-existing-provider.ts
git -C "$repo4" -c user.email=t@t -c user.name=t commit -q -m "init provider"
# Now modify it.
echo "// edit" >> "$repo4/src/provisioning/providers/fake-existing-provider.ts"
git -C "$repo4" add src/provisioning/providers/fake-existing-provider.ts
run_case "edit (status M) on existing provider allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m fix"}}' "$repo4")"

# --- Fixture 5: non-git-commit command → pass-through ---
repo5="$TMPDIR/fixture5"
init_repo "$repo5"
write_provider "$repo5" "fake-qux-provider" yes
git -C "$repo5" add src/provisioning/providers/fake-qux-provider.ts
run_case "non-git-commit command passes through (ls)" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"ls -la"}}' "$repo5")"
run_case "non-git-commit command passes through (git status)" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git status"}}' "$repo5")"
run_case "non-git-commit command passes through (git push)" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git push origin feat/x"}}' "$repo5")"

# --- Edge case: existing roundtrip test (already committed) satisfies a re-add scenario.
# A user adds a provider that has the same base name as an already-committed test (rare
# but possible for refactor/rename flows). The hook should pass.
repo6="$TMPDIR/fixture6"
init_repo "$repo6"
write_test "$repo6" "tests/unit/provisioning/fake-rename-provider-roundtrip.test.ts"
git -C "$repo6" add tests/unit/provisioning/fake-rename-provider-roundtrip.test.ts
git -C "$repo6" -c user.email=t@t -c user.name=t commit -q -m "init test"
write_provider "$repo6" "fake-rename-provider" yes
git -C "$repo6" add src/provisioning/providers/fake-rename-provider.ts
run_case "new provider with existing committed test allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m refactor"}}' "$repo6")"

# --- Edge case: git -C <repo> commit from outside the repo dir resolves correctly.
repo7="$TMPDIR/fixture7"
init_repo "$repo7"
write_provider "$repo7" "fake-c-provider" yes
git -C "$repo7" add src/provisioning/providers/fake-c-provider.ts
run_case "git -C <repo> commit (no test) blocked" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git -C %s commit -m feat"}}' "$TMPDIR" "$repo7")"

# --- Edge case: missing cwd → fall back to PWD; no crash.
run_case "missing .cwd does not crash" 0 \
  '{"tool_input":{"command":"git status"}}'

# --- Edge case: empty stdin → cmd empty → allowed.
run_case "empty stdin allowed" 0 ''

echo
echo "Pass: $pass  Fail: $fail"
if [[ "$fail" -gt 0 ]]; then
  echo
  printf '%b' "$fail_log"
  exit 1
fi
