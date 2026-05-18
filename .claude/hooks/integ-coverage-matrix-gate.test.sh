#!/usr/bin/env bash
# Smoke test for integ-coverage-matrix-gate.sh.
#
# Builds fixture git repos with a structure that mimics cdkd
# (src/provisioning/register-providers.ts, tests/integration/<name>/
# {lib,bin}/*.ts, a stand-in regenerator at
# scripts/build-integ-coverage-matrix.ts, and the matrix snapshot files
# under docs/) and exercises each branch of the hook. Run from any cwd:
#
#   bash .claude/hooks/integ-coverage-matrix-gate.test.sh

set -u

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/integ-coverage-matrix-gate.sh"

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

# Stand-in regenerator. Reads every src/provisioning/register-providers.ts
# + tests/integration/<name>/{lib,bin}/*.ts, concatenates their contents,
# and writes the result to docs/integ-coverage.md +
# docs/_generated/integ-coverage.json. This is structurally analogous to
# the real script (output is a pure function of the input source files)
# so the hook's "is the matrix stale?" check exercises end-to-end.
#
# If CDKD_TEST_REGEN_CRASH=1 is set in the env, the script exits 1 to
# exercise the hook's crash-tolerant branch.
make_regen_script() {
  local dir="$1"
  mkdir -p "$dir/scripts" "$dir/docs/_generated"
  cat > "$dir/scripts/build-integ-coverage-matrix.ts" <<'EOF'
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

if (process.env.CDKD_TEST_REGEN_CRASH === '1') {
  console.error('fake regenerator: intentional crash');
  process.exit(1);
}

const parts: string[] = [];

const reg = 'src/provisioning/register-providers.ts';
if (existsSync(reg)) parts.push(readFileSync(reg, 'utf8'));

const integDir = 'tests/integration';
if (existsSync(integDir)) {
  for (const name of readdirSync(integDir).sort()) {
    const fixture = join(integDir, name);
    if (!statSync(fixture).isDirectory()) continue;
    for (const sub of ['lib', 'bin']) {
      const subDir = join(fixture, sub);
      if (!existsSync(subDir)) continue;
      for (const f of readdirSync(subDir).sort()) {
        if (!f.endsWith('.ts')) continue;
        parts.push(readFileSync(join(subDir, f), 'utf8'));
      }
    }
  }
}

const text = parts.join('\n---\n');
if (!existsSync('docs/_generated')) mkdirSync('docs/_generated', { recursive: true });
writeFileSync('docs/integ-coverage.md', text);
writeFileSync('docs/_generated/integ-coverage.json', text);
EOF
}

# Regenerate the matrix files to match the current source state (so the
# baseline commit lands with an up-to-date snapshot).
sync_matrix() {
  local dir="$1"
  ( cd "$dir" && node --experimental-strip-types scripts/build-integ-coverage-matrix.ts )
}

# init_repo <dir> — seed with the regenerator + one register line + one
# tracked fixture + an up-to-date matrix snapshot. The trap covers the
# rm -rf at exit so leftover state from one test doesn't bleed into
# the next.
init_repo() {
  local dir="$1"
  git init -q -b main "$dir"
  git -C "$dir" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
  mkdir -p "$dir/src/provisioning" "$dir/tests/integration/baseline/lib"
  cat > "$dir/src/provisioning/register-providers.ts" <<'EOF'
export function registerAllProviders(): void {
  registry.register('AWS::IAM::Role', new IAMRoleProvider());
}
EOF
  cat > "$dir/tests/integration/baseline/lib/baseline-stack.ts" <<'EOF'
import * as cdk from 'aws-cdk-lib';
// covers: AWS::IAM::Role
export class BaselineStack extends cdk.Stack {}
EOF
  make_regen_script "$dir"
  sync_matrix "$dir"
  git -C "$dir" add -A
  git -C "$dir" -c user.email=t@t -c user.name=t commit -q -m baseline
}

stage_all() { git -C "$1" add -A; }

run_hook() {
  local dir="$1" cmd_override="${2:-}"
  local payload
  local cmd_str
  if [[ -n "$cmd_override" ]]; then
    cmd_str="$cmd_override"
  else
    cmd_str="git -C $dir commit -m test"
  fi
  payload=$(printf '{"tool_input":{"command":"%s"},"cwd":"%s"}' "$cmd_str" "$dir")
  printf '%s' "$payload" | bash "$HOOK" >/dev/null 2>&1
}

# Like run_hook but captures stderr so tests can grep for warn lines.
run_hook_capture_stderr() {
  local dir="$1"
  local payload
  payload=$(printf '{"tool_input":{"command":"git -C %s commit -m test"},"cwd":"%s"}' "$dir" "$dir")
  printf '%s' "$payload" | bash "$HOOK" 2>&1 >/dev/null
}

PASS=0
FAIL=0
case_label() { printf '  case: %s\n' "$1"; }
ok() { PASS=$((PASS + 1)); printf '    PASS\n'; }
ng() { FAIL=$((FAIL + 1)); printf '    FAIL: expected exit %s, got %s\n' "$1" "$2"; }
ng_msg() { FAIL=$((FAIL + 1)); printf '    FAIL: %s\n' "$1"; }

# --- Case 1: no scope-touching diff -> pass ---
case_label "no scope-touching diff -> pass"
D="$TMPDIR/case1"; init_repo "$D"
echo "README" > "$D/README.md"
stage_all "$D"
run_hook "$D"; rc=$?
if [[ $rc -eq 0 ]]; then ok; else ng 0 "$rc"; fi

# --- Case 2: scope-touching diff + matrix already up to date -> pass ---
case_label "scope-touching diff + matrix in sync -> pass"
D="$TMPDIR/case2"; init_repo "$D"
mkdir -p "$D/tests/integration/foo/lib"
cat > "$D/tests/integration/foo/lib/foo-stack.ts" <<'EOF'
import * as cdk from 'aws-cdk-lib';
export class FooStack extends cdk.Stack {}
EOF
sync_matrix "$D"
stage_all "$D"
run_hook "$D"; rc=$?
if [[ $rc -eq 0 ]]; then ok; else ng 0 "$rc"; fi

# --- Case 3: scope-touching diff + matrix stale -> block (exit 2) ---
case_label "scope-touching diff + matrix stale -> block"
D="$TMPDIR/case3"; init_repo "$D"
mkdir -p "$D/tests/integration/foo/lib"
cat > "$D/tests/integration/foo/lib/foo-stack.ts" <<'EOF'
import * as cdk from 'aws-cdk-lib';
export class FooStack extends cdk.Stack {}
EOF
# Deliberately do NOT regen — the user forgot.
stage_all "$D"
run_hook "$D"; rc=$?
if [[ $rc -eq 2 ]]; then ok; else ng 2 "$rc"; fi

# --- Case 4: hook restores originals when blocking ---
case_label "block does not leave the working tree modified"
D="$TMPDIR/case4"; init_repo "$D"
mkdir -p "$D/tests/integration/foo/lib"
cat > "$D/tests/integration/foo/lib/foo-stack.ts" <<'EOF'
import * as cdk from 'aws-cdk-lib';
export class FooStack extends cdk.Stack {}
EOF
md_pre=$(cat "$D/docs/integ-coverage.md")
json_pre=$(cat "$D/docs/_generated/integ-coverage.json")
stage_all "$D"
run_hook "$D"; rc=$?
md_post=$(cat "$D/docs/integ-coverage.md")
json_post=$(cat "$D/docs/_generated/integ-coverage.json")
if [[ $rc -eq 2 && "$md_pre" == "$md_post" && "$json_pre" == "$json_post" ]]; then
  ok
else
  ng_msg "rc=$rc md_changed=$([[ "$md_pre" != "$md_post" ]] && echo yes || echo no) json_changed=$([[ "$json_pre" != "$json_post" ]] && echo yes || echo no)"
fi

# --- Case 5: regenerator crash -> exit 0 with warn ---
case_label "regenerator crash -> pass with warn"
D="$TMPDIR/case5"; init_repo "$D"
mkdir -p "$D/tests/integration/foo/lib"
cat > "$D/tests/integration/foo/lib/foo-stack.ts" <<'EOF'
import * as cdk from 'aws-cdk-lib';
export class FooStack extends cdk.Stack {}
EOF
stage_all "$D"
# Mark the script to crash on this invocation by inlining the env-var
# read into the hook's `node` call. The hook reads the working tree's
# script which checks process.env.CDKD_TEST_REGEN_CRASH at startup.
md_pre=$(cat "$D/docs/integ-coverage.md")
json_pre=$(cat "$D/docs/_generated/integ-coverage.json")
payload=$(printf '{"tool_input":{"command":"git -C %s commit -m test"},"cwd":"%s"}' "$D" "$D")
stderr_out=$(CDKD_TEST_REGEN_CRASH=1 printf '%s' "$payload" | CDKD_TEST_REGEN_CRASH=1 bash "$HOOK" 2>&1 >/dev/null)
rc=$?
md_post=$(cat "$D/docs/integ-coverage.md")
json_post=$(cat "$D/docs/_generated/integ-coverage.json")
if [[ $rc -eq 0 && "$md_pre" == "$md_post" && "$json_pre" == "$json_post" ]] && \
   printf '%s' "$stderr_out" | grep -q "regenerator failed"; then
  ok
else
  ng_msg "rc=$rc md_changed=$([[ "$md_pre" != "$md_post" ]] && echo yes || echo no) stderr=$stderr_out"
fi

# --- Case 6: missing regenerator script -> pass (no-op) ---
case_label "missing regenerator script -> pass"
D="$TMPDIR/case6"; init_repo "$D"
rm "$D/scripts/build-integ-coverage-matrix.ts"
mkdir -p "$D/tests/integration/foo/lib"
echo 'export class FooStack {}' > "$D/tests/integration/foo/lib/foo-stack.ts"
stage_all "$D"
run_hook "$D"; rc=$?
if [[ $rc -eq 0 ]]; then ok; else ng 0 "$rc"; fi

# --- Case 7: refactor that doesn't change matrix output -> pass ---
case_label "refactor that doesn't change matrix -> pass"
D="$TMPDIR/case7"; init_repo "$D"
# Edit a scope file in a way that DOES change the matrix output (this
# regenerator is a literal concat, so any edit changes the output).
# Then regen to bring the matrix in sync. The hook should treat this
# as "matrix already in sync" = pass.
sed -i.bak 's/IAMRoleProvider/IAMRoleProvider2/' "$D/src/provisioning/register-providers.ts"
rm "$D/src/provisioning/register-providers.ts.bak"
sync_matrix "$D"
stage_all "$D"
run_hook "$D"; rc=$?
if [[ $rc -eq 0 ]]; then ok; else ng 0 "$rc"; fi

# --- Case 8: non-commit command -> pass ---
case_label "git push -> pass (hook only gates commit)"
D="$TMPDIR/case8"; init_repo "$D"
mkdir -p "$D/tests/integration/foo/lib"
echo 'export class FooStack {}' > "$D/tests/integration/foo/lib/foo-stack.ts"
stage_all "$D"
run_hook "$D" "git -C $D push origin main"; rc=$?
if [[ $rc -eq 0 ]]; then ok; else ng 0 "$rc"; fi

# --- Case 9: cd <path> prefix routes target dir ---
case_label "cd <path> && git commit -> routes target dir"
D="$TMPDIR/case9"; init_repo "$D"
mkdir -p "$D/tests/integration/foo/lib"
echo 'export class FooStack {}' > "$D/tests/integration/foo/lib/foo-stack.ts"
stage_all "$D"
# Pass hook_cwd as /tmp (some unrelated dir) and use `cd <D> && git commit`
# in the command. The hook should resolve target_dir=D via the cd prefix
# and detect the stale matrix.
payload=$(printf '{"tool_input":{"command":"cd %s && git commit -m test"},"cwd":"/tmp"}' "$D")
printf '%s' "$payload" | bash "$HOOK" >/dev/null 2>&1; rc=$?
if [[ $rc -eq 2 ]]; then ok; else ng 2 "$rc"; fi

# --- Case 10: only register-providers.ts staged (no integ file) -> still gates ---
case_label "register-providers.ts staged alone -> gates"
D="$TMPDIR/case10"; init_repo "$D"
cat >> "$D/src/provisioning/register-providers.ts" <<'EOF'
// new line to bump matrix
EOF
# Don't regen.
stage_all "$D"
run_hook "$D"; rc=$?
if [[ $rc -eq 2 ]]; then ok; else ng 2 "$rc"; fi

# --- Case 11: tests/integration/<name>/bin/*.ts staged -> gates ---
case_label "bin file staged -> gates"
D="$TMPDIR/case11"; init_repo "$D"
mkdir -p "$D/tests/integration/baseline/bin"
echo 'export const x = 1;' > "$D/tests/integration/baseline/bin/app.ts"
# Don't regen.
stage_all "$D"
run_hook "$D"; rc=$?
if [[ $rc -eq 2 ]]; then ok; else ng 2 "$rc"; fi

# --- Case 12: matrix files staged but stale relative to source -> still blocks ---
# Catches the user who hand-edits the matrix without running the regen.
case_label "matrix staged but inconsistent with source -> still blocks"
D="$TMPDIR/case12"; init_repo "$D"
mkdir -p "$D/tests/integration/foo/lib"
cat > "$D/tests/integration/foo/lib/foo-stack.ts" <<'EOF'
import * as cdk from 'aws-cdk-lib';
export class FooStack extends cdk.Stack {}
EOF
# Hand-craft a misleading matrix that doesn't reflect the new fixture.
echo "wrong content" > "$D/docs/integ-coverage.md"
echo "wrong content" > "$D/docs/_generated/integ-coverage.json"
stage_all "$D"
run_hook "$D"; rc=$?
if [[ $rc -eq 2 ]]; then ok; else ng 2 "$rc"; fi

# --- Case 13: PR #432 bypass form (`git -C <abs> commit -F /tmp/file`) -> blocks ---
# Pre-issue-#433 the hook script handled this form correctly when invoked
# directly (the inner `git[^|;&]*commit` regex matches `git -C /abs commit`),
# but the `if:` matcher in .claude/settings.json was `Bash(git commit*)`
# which does NOT match commands starting with `git -C <path> commit ...`
# — so the harness never invoked the hook for PR #432's first commit.
# This test pins the hook-script behavior for the bypass form so that
# even if the matcher is broadened (the actual fix), a regression in the
# hook script itself still surfaces here.
case_label "PR #432 bypass form (git -C <abs> commit -F /tmp/msg) -> blocks"
D="$TMPDIR/case13"; init_repo "$D"
mkdir -p "$D/tests/integration/foo/lib"
cat > "$D/tests/integration/foo/lib/foo-stack.ts" <<'EOF'
import * as cdk from 'aws-cdk-lib';
export class FooStack extends cdk.Stack {}
EOF
stage_all "$D"
echo "test msg" > "$TMPDIR/msg-case13"
run_hook "$D" "git -C $D commit -F $TMPDIR/msg-case13"; rc=$?
if [[ $rc -eq 2 ]]; then ok; else ng 2 "$rc"; fi

# --- Case 14: chained `git -C add ; git -C commit` form -> blocks ---
# The other half of the PR #432 hypothesis: harness-issued chains of
# `git -C <abs> add <files>; git -C <abs> commit -F /tmp/msg` need to
# block when the staged set drifts the matrix.
case_label "chained 'git -C add; git -C commit -F' form -> blocks"
D="$TMPDIR/case14"; init_repo "$D"
mkdir -p "$D/tests/integration/foo/lib"
cat > "$D/tests/integration/foo/lib/foo-stack.ts" <<'EOF'
import * as cdk from 'aws-cdk-lib';
export class FooStack extends cdk.Stack {}
EOF
stage_all "$D"
echo "test msg" > "$TMPDIR/msg-case14"
chained="git -C $D add tests/integration/foo/lib/foo-stack.ts; git -C $D commit -F $TMPDIR/msg-case14"
run_hook "$D" "$chained"; rc=$?
if [[ $rc -eq 2 ]]; then ok; else ng 2 "$rc"; fi

# --- Case 15: CDKD_HOOK_DEBUG=1 surfaces an entry log line ---
# Issue #433 acceptance criteria (optional): a [debug] log line at hook
# entry so future bypasses surface visibly.
case_label "CDKD_HOOK_DEBUG=1 surfaces entry log"
D="$TMPDIR/case15"; init_repo "$D"
mkdir -p "$D/tests/integration/foo/lib"
echo 'export class FooStack {}' > "$D/tests/integration/foo/lib/foo-stack.ts"
stage_all "$D"
payload=$(printf '{"tool_input":{"command":"git -C %s commit -m test"},"cwd":"%s"}' "$D" "$D")
stderr_out=$(CDKD_HOOK_DEBUG=1 printf '%s' "$payload" | CDKD_HOOK_DEBUG=1 bash "$HOOK" 2>&1 >/dev/null)
if printf '%s' "$stderr_out" | grep -q '\[debug\] integ-coverage-matrix-gate: entered'; then
  ok
else
  ng_msg "expected debug entry log; got: $stderr_out"
fi

echo
echo "integ-coverage-matrix-gate.test.sh: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
