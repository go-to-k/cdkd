#!/usr/bin/env bash
# Smoke test for cmd-parse-stub-gate.sh.
#
# Asserts the hook blocks staged test files with a `cmd.parse(...)`
# call lacking a nearby `.action(...)` stub, and passes through
# variants that are safe (parseAsync, parse-with-stub, non-test files,
# files without parse calls).
#
# Run from the repo root: `bash .claude/hooks/cmd-parse-stub-gate.test.sh`.

set -u

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/cmd-parse-stub-gate.sh"

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

# Build a fixture repo, stage variations of test files, run the hook
# against each, capture the exit code.
fixture_repo="$TMPDIR/repo"
git init -q -b feature/x "$fixture_repo"
git -C "$fixture_repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init

mkdir -p "$fixture_repo/tests/unit/cli"

pass=0
fail=0
fail_log=""

# Stage a single file with the given path / content, run the hook,
# assert the expected exit code, then unstage.
run_case() {
  local name="$1"; local want="$2"; local rel_path="$3"; local content="$4"
  mkdir -p "$fixture_repo/$(dirname "$rel_path")"
  printf '%s' "$content" > "$fixture_repo/$rel_path"
  git -C "$fixture_repo" add -- "$rel_path" 2>/dev/null

  local payload
  payload=$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m test"}}' "$fixture_repo")
  local out got
  out=$(printf '%s' "$payload" | "$HOOK" 2>&1) || true
  got=$?
  printf '%s' "$payload" | "$HOOK" >/dev/null 2>&1
  got=$?

  if [[ "$got" == "$want" ]]; then
    pass=$((pass + 1))
    printf 'OK   %s (exit %s)\n' "$name" "$got"
  else
    fail=$((fail + 1))
    fail_log+="FAIL $name: want exit $want, got $got\n"
    fail_log+="  file   : $rel_path\n"
    fail_log+="  output : $out\n"
    printf 'FAIL %s (want %s, got %s)\n' "$name" "$want" "$got"
  fi

  # Cleanup for next case.
  git -C "$fixture_repo" rm -q -f --cached -- "$rel_path" 2>/dev/null || true
  rm -f "$fixture_repo/$rel_path"
}

# --- PASS-THROUGH cases ---

# 1. Test file without any `cmd.parse(...)` call → pass.
run_case "test file without cmd.parse passes" 0 \
  "tests/unit/cli/plain.test.ts" \
  "import { describe } from 'vitest';
describe('plain', () => {});
"

# 2. Test file with `cmd.parseAsync(...)` (NOT `.parse(...)`) → pass.
#    parseAsync surfaces rejections via await, no stub required.
run_case "cmd.parseAsync passes" 0 \
  "tests/unit/cli/async.test.ts" \
  "import { Command } from 'commander';
const cmd = new Command();
await cmd.parseAsync(['node', 'cli', 'foo'], { from: 'user' });
"

# 3. Test file with `cmd.parse(...)` AND a nearby `cmd.action(() => {})` → pass.
run_case "cmd.parse with action stub passes" 0 \
  "tests/unit/cli/stubbed.test.ts" \
  "import { Command } from 'commander';
const cmd = new Command();
cmd.action(() => {});
cmd.parse(['node', 'cli', 'foo'], { from: 'user' });
"

# 4. Non-test file (e.g. src/) with `cmd.parse(...)` → pass (production
#    code's parse calls are intentional).
run_case "non-test file with cmd.parse passes" 0 \
  "src/cli/main.ts" \
  "import { Command } from 'commander';
const cmd = new Command();
cmd.parse(process.argv);
"

# 5. `.action()` declared inside a helper function above the parse call,
#    within the 60-line lookback window → pass.
run_case "action in helper above parse passes" 0 \
  "tests/unit/cli/helper.test.ts" \
  "import { Command } from 'commander';
function buildCmd() {
  const c = new Command();
  c.action(() => {});
  return c;
}
const cmd = buildCmd();
cmd.parse(['node', 'cli'], { from: 'user' });
"

# 5b. The real-world pattern from tests/unit/cli/local-run-task.test.ts:
#    action stub at the top of a describe(), parses inside individual
#    it() blocks ~35-50 lines below. The 60-line lookback covers this.
suite_filler=""
for i in $(seq 1 30); do
  suite_filler="${suite_filler}  // suite filler $i
"
done
run_case "describe-suite stub + later it-block parse passes" 0 \
  "tests/unit/cli/suite.test.ts" \
  "import { Command } from 'commander';
import { describe, it } from 'vitest';
describe('foo', () => {
  const cmd = new Command();
  cmd.action(() => {});
${suite_filler}  it('parses', () => {
    cmd.parse(['node', 'cli'], { from: 'user' });
  });
});
"

# 5c. Comment line mentioning \`cmd.parse(...)\` inside a docstring →
#    pass-through. Without the comment filter the hook would flag the
#    file as having an unstubbed parse even though every real call is
#    stubbed.
run_case "comment-line cmd.parse reference ignored" 0 \
  "tests/unit/cli/commented.test.ts" \
  "import { Command } from 'commander';
const cmd = new Command();
cmd.action(() => {});
// cmd.parse([...]) without a stub crashes on Node 24 — see PR #266.
cmd.parse(['node', 'cli'], { from: 'user' });
"

# --- BLOCK cases ---

# 6. Test file with `cmd.parse(...)` and NO `.action(...)` anywhere → block.
run_case "cmd.parse without any action blocked" 2 \
  "tests/unit/cli/unstubbed.test.ts" \
  "import { Command } from 'commander';
const cmd = new Command();
cmd.parse(['node', 'cli', 'foo'], { from: 'user' });
"

# 7. `.action(...)` exists but >60 lines above → block.
#    Build a file with 65 filler lines between the action and the parse.
filler=""
for i in $(seq 1 65); do
  filler="${filler}// filler line $i
"
done
run_case "cmd.parse with action too far away blocked" 2 \
  "tests/unit/cli/far.test.ts" \
  "import { Command } from 'commander';
const cmd = new Command();
cmd.action(() => {});
${filler}cmd.parse(['node', 'cli'], { from: 'user' });
"

# 8. Multi-parse: one stubbed, one not, with > 60 lines between them →
#    block on the second (unstubbed) parse. This is the per-call
#    locality the lookback heuristic protects: a stub-far-above only
#    pairs with parses inside its window, not every parse in the file.
filler=""
for i in $(seq 1 65); do
  filler="${filler}// filler line $i
"
done
run_case "mixed stubbed/unstubbed multi-parse blocked" 2 \
  "tests/unit/cli/mixed.test.ts" \
  "import { Command } from 'commander';
function runOne() {
  const cmd = new Command();
  cmd.action(() => {});
  cmd.parse(['node', 'cli'], { from: 'user' });
}
${filler}function runTwo() {
  const cmd = new Command();
  // NO action stub here, and the runOne action is > 60 lines above!
  cmd.parse(['node', 'cli'], { from: 'user' });
}
"

# --- Edge cases ---

# 9. Empty stdin → empty cmd → allowed (no commit to gate).
payload=''
out=$(printf '%s' "$payload" | "$HOOK" 2>&1) || true
got=$?
printf '%s' "$payload" | "$HOOK" >/dev/null 2>&1
got=$?
if [[ "$got" == 0 ]]; then
  pass=$((pass + 1))
  printf 'OK   empty stdin allowed (exit %s)\n' "$got"
else
  fail=$((fail + 1))
  fail_log+="FAIL empty stdin: want 0, got $got\n"
  printf 'FAIL empty stdin (want 0, got %s)\n' "$got"
fi

# 10. Non-commit command (e.g. git status) → pass-through.
payload=$(printf '{"cwd":"%s","tool_input":{"command":"git status"}}' "$fixture_repo")
out=$(printf '%s' "$payload" | "$HOOK" 2>&1) || true
printf '%s' "$payload" | "$HOOK" >/dev/null 2>&1
got=$?
if [[ "$got" == 0 ]]; then
  pass=$((pass + 1))
  printf 'OK   non-commit command allowed (exit %s)\n' "$got"
else
  fail=$((fail + 1))
  fail_log+="FAIL non-commit: want 0, got $got\n"
  printf 'FAIL non-commit command (want 0, got %s)\n' "$got"
fi

echo
echo "Pass: $pass  Fail: $fail"
if [[ "$fail" -gt 0 ]]; then
  echo
  printf '%b' "$fail_log"
  exit 1
fi
